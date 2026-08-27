-- Forward-only account lifecycle contract.
--
-- This migration adds a stable account_id boundary around the existing
-- app_account_credentials table.  Legacy v3/v4 demo cookies remain a
-- deliberately gated transition path; new logins use the database session
-- ledger below.  Passwords, raw invite/recovery values, and plaintext MFA
-- secrets are never stored, audited, or returned by these functions.

set local lock_timeout = '1s';

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

-- Existing independent credentials are bridged by their already-stable
-- identity_key.  The nullable column keeps this migration compatible with
-- credentials written by the previous migration before this one is deployed.
alter table internal.app_account_credentials
  add column if not exists account_id uuid;

insert into internal.app_accounts (
  identity_key, account_name, account_role, status, super_admin,
  created_by, updated_by
)
values (
  encode(extensions.digest(
    convert_to('yinling-account-v1', 'UTF8') || decode('00', 'hex')
      || convert_to('admin', 'UTF8') || decode('00', 'hex') || convert_to('nixon', 'UTF8'),
    'sha256'
  ), 'hex'),
  'Nixon', 'admin', 'active', true, 'account-lifecycle-migration', 'account-lifecycle-migration'
), (
  encode(extensions.digest(
    convert_to('yinling-account-v1', 'UTF8') || decode('00', 'hex')
      || convert_to('limited-admin', 'UTF8') || decode('00', 'hex') || convert_to('ops admin', 'UTF8'),
    'sha256'
  ), 'hex'),
  'Ops Admin', 'limited-admin', 'active', false, 'account-lifecycle-migration', 'account-lifecycle-migration'
)
on conflict (identity_key) do update
set account_name = excluded.account_name,
    account_role = excluded.account_role,
    super_admin = case when excluded.super_admin then true else internal.app_accounts.super_admin end,
    updated_at = now(),
    updated_by = 'account-lifecycle-migration';

insert into internal.app_accounts (
  identity_key, account_name, account_role, status, super_admin,
  created_by, updated_by
)
select c.identity_key, trim(c.account_name), c.account_role, 'active',
  lower(trim(c.account_name)) = 'nixon' and c.account_role = 'admin',
  'credential-bridge', 'credential-bridge'
from internal.app_account_credentials c
on conflict (identity_key) do nothing;

update internal.app_account_credentials c
set account_id = a.account_id
from internal.app_accounts a
where a.identity_key = c.identity_key
  and c.account_id is distinct from a.account_id;

alter table internal.app_account_credentials
  drop constraint if exists app_account_credentials_account_id_fkey;
alter table internal.app_account_credentials
  add constraint app_account_credentials_account_id_fkey
  foreign key (account_id) references internal.app_accounts(account_id) on delete restrict;
create index if not exists app_account_credentials_account_id_idx
  on internal.app_account_credentials(account_id);

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

create table if not exists internal.app_account_commands (
  command_key text primary key check (
    command_key ~ '^account-[a-z0-9-]+:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  action text not null check (length(action) between 1 and 80),
  account_id uuid references internal.app_accounts(account_id) on delete restrict,
  actor_account_id uuid references internal.app_accounts(account_id) on delete restrict,
  result_version bigint,
  audit_id uuid not null references internal.operational_contract_audit(id),
  created_at timestamptz not null default now()
);

create table if not exists internal.app_account_invites (
  invite_id uuid primary key default gen_random_uuid(),
  command_key text not null unique references internal.app_account_commands(command_key) on delete restrict,
  account_id uuid not null references internal.app_accounts(account_id) on delete restrict,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  delivery_status text not null default 'delivery_unconfigured'
    check (delivery_status = 'delivery_unconfigured'),
  created_by uuid not null references internal.app_accounts(account_id) on delete restrict,
  created_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  check (expires_at > created_at)
);

create table if not exists internal.app_account_recovery_tokens (
  recovery_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references internal.app_accounts(account_id) on delete restrict,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  requested_at timestamptz not null default now(),
  audit_id uuid not null references internal.operational_contract_audit(id),
  check (expires_at > requested_at)
);
create index if not exists app_account_recovery_active_idx
  on internal.app_account_recovery_tokens(account_id, expires_at)
  where consumed_at is null;

create table if not exists internal.app_account_sessions (
  session_id uuid primary key,
  account_id uuid not null references internal.app_accounts(account_id) on delete restrict,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  absolute_expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  user_agent text check (user_agent is null or length(user_agent) <= 512),
  mfa_verified boolean not null default false,
  revoked_at timestamptz,
  revoke_reason text,
  access_version bigint not null check (access_version > 0),
  check (idle_expires_at <= absolute_expires_at)
);
create index if not exists app_account_sessions_account_active_idx
  on internal.app_account_sessions(account_id, created_at desc)
  where revoked_at is null;

create table if not exists internal.app_account_mfa (
  account_id uuid primary key references internal.app_accounts(account_id) on delete restrict,
  secret_ciphertext text not null check (
    secret_ciphertext ~ '^mfa:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'
  ),
  enabled boolean not null default false,
  mfa_version bigint not null default 1 check (mfa_version > 0),
  updated_at timestamptz not null default now(),
  updated_by text not null check (length(trim(updated_by)) between 1 and 160)
);

alter table internal.app_accounts enable row level security;
alter table internal.app_account_permission_overrides enable row level security;
alter table internal.app_account_scope_members enable row level security;
alter table internal.app_account_commands enable row level security;
alter table internal.app_account_invites enable row level security;
alter table internal.app_account_recovery_tokens enable row level security;
alter table internal.app_account_sessions enable row level security;
alter table internal.app_account_mfa enable row level security;

revoke all on table internal.app_accounts from public, anon, authenticated;
revoke all on table internal.app_account_permission_overrides from public, anon, authenticated;
revoke all on table internal.app_account_scope_members from public, anon, authenticated;
revoke all on table internal.app_account_commands from public, anon, authenticated;
revoke all on table internal.app_account_invites from public, anon, authenticated;
revoke all on table internal.app_account_recovery_tokens from public, anon, authenticated;
revoke all on table internal.app_account_sessions from public, anon, authenticated;
revoke all on table internal.app_account_mfa from public, anon, authenticated;

create or replace function internal.app_account_identity_key(
  p_account_name text,
  p_account_role text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(
    convert_to('yinling-account-v1', 'UTF8') || decode('00', 'hex')
      || convert_to(p_account_role, 'UTF8') || decode('00', 'hex')
      || convert_to(lower(trim(p_account_name)), 'UTF8'),
    'sha256'
  ), 'hex')
$$;
revoke all on function internal.app_account_identity_key(text, text) from public, anon, authenticated;

create or replace function internal.app_account_default_permissions(p_account_role text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_account_role
    when 'admin' then array[
      'accounts.read', 'accounts.manage', 'accounts.sessions.revoke', 'accounts.mfa.reset',
      'operations.read', 'operations.write', 'payroll.read'
    ]::text[]
    when 'limited-admin' then array[
      'accounts.read', 'operations.read', 'operations.write'
    ]::text[]
    when 'staff' then array[
      'operations.read', 'operations.write'
    ]::text[]
    when 'teacher' then array[
      'students.read.assigned', 'bookings.read.assigned', 'bookings.write.assigned'
    ]::text[]
    else array[]::text[]
  end
$$;
revoke all on function internal.app_account_default_permissions(text) from public, anon, authenticated;

create or replace function internal.app_account_effective_permissions(
  p_account_id uuid,
  p_account_role text,
  p_super_admin boolean
)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_super_admin then array['*']::text[] else coalesce(array_agg(permission order by permission), array[]::text[]) end
  from (
    select distinct permission
    from unnest(internal.app_account_default_permissions(p_account_role)) permission
    union
    select o.permission
    from internal.app_account_permission_overrides o
    where o.account_id = p_account_id and o.allowed
  ) enabled_permissions
  where p_super_admin or not exists (
    select 1
    from internal.app_account_permission_overrides denied
    where denied.account_id = p_account_id
      and denied.permission = enabled_permissions.permission
      and not denied.allowed
  )
$$;
revoke all on function internal.app_account_effective_permissions(uuid, text, boolean) from public, anon, authenticated;

create or replace function internal.app_account_effective_scope(
  p_account_id uuid,
  p_account_role text,
  p_super_admin boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_super_admin then jsonb_build_array(jsonb_build_object('kind', 'all', 'key', '*'))
    when p_account_role in ('admin', 'limited-admin') and not exists (
      select 1 from internal.app_account_scope_members s where s.account_id = p_account_id
    ) then jsonb_build_array(jsonb_build_object('kind', 'all', 'key', '*'))
    else coalesce((
      select jsonb_agg(jsonb_build_object('kind', s.scope_kind, 'key', s.scope_key) order by s.scope_kind, s.scope_key)
      from internal.app_account_scope_members s
      where s.account_id = p_account_id
    ), '[]'::jsonb)
  end
$$;
revoke all on function internal.app_account_effective_scope(uuid, text, boolean) from public, anon, authenticated;

-- Stable, secret-gated directory read.  No credential material is selected.
create or replace function public.read_account_by_identity(
  p_secret text,
  p_identity_key text
)
returns table (
  account_id uuid,
  identity_key text,
  account_name text,
  account_role text,
  status text,
  super_admin boolean,
  access_version bigint,
  role_version bigint,
  scope_version bigint,
  credential_version bigint,
  must_change_password boolean,
  mfa_enabled boolean,
  legacy_session_allowed boolean,
  created_at timestamptz,
  updated_at timestamptz,
  updated_by text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_identity_key, '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_account_identity_key';
  end if;
  return query
  select a.account_id, a.identity_key, a.account_name, a.account_role, a.status,
    a.super_admin, a.access_version, a.role_version, a.scope_version,
    c.credential_version, c.must_change_password, coalesce(m.enabled, false),
    a.legacy_session_allowed, a.created_at, a.updated_at, a.updated_by
  from internal.app_accounts a
  left join internal.app_account_credentials c on c.account_id = a.account_id
  left join internal.app_account_mfa m on m.account_id = a.account_id
  where a.identity_key = p_identity_key;
end;
$$;

create or replace function public.read_account_directory(
  p_secret text,
  p_actor_account_id uuid
)
returns table (
  account_id uuid,
  identity_key text,
  account_name text,
  account_role text,
  status text,
  super_admin boolean,
  access_version bigint,
  role_version bigint,
  scope_version bigint,
  credential_version bigint,
  must_change_password boolean,
  mfa_enabled boolean,
  legacy_session_allowed boolean,
  created_at timestamptz,
  updated_at timestamptz,
  updated_by text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare actor internal.app_accounts%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id;
  if actor.account_id is null or actor.status <> 'active' or not actor.super_admin then
    raise exception using errcode = '42501', message = 'account_directory_forbidden';
  end if;
  return query
  select a.account_id, a.identity_key, a.account_name, a.account_role, a.status,
    a.super_admin, a.access_version, a.role_version, a.scope_version,
    c.credential_version, c.must_change_password, coalesce(m.enabled, false),
    a.legacy_session_allowed, a.created_at, a.updated_at, a.updated_by
  from internal.app_accounts a
  left join internal.app_account_credentials c on c.account_id = a.account_id
  left join internal.app_account_mfa m on m.account_id = a.account_id
  order by lower(a.account_name), a.account_id;
end;
$$;

-- The demo adapter calls this only after resolving a known server-side legacy
-- identity. It never creates an arbitrary client-supplied role.
create or replace function public.ensure_account_directory(
  p_secret text,
  p_identity_key text,
  p_account_name text,
  p_account_role text
)
returns table (
  account_id uuid,
  identity_key text,
  account_name text,
  account_role text,
  status text,
  super_admin boolean,
  access_version bigint,
  role_version bigint,
  scope_version bigint,
  credential_version bigint,
  must_change_password boolean,
  mfa_enabled boolean,
  legacy_session_allowed boolean,
  created_at timestamptz,
  updated_at timestamptz,
  updated_by text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.app_accounts%rowtype;
  credential internal.app_account_credentials%rowtype;
  audit_id uuid;
  canonical_name text;
  expected_identity text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  canonical_name := trim(p_account_name);
  expected_identity := internal.app_account_identity_key(canonical_name, p_account_role);
  if coalesce(p_identity_key, '') <> expected_identity
     or length(canonical_name) not between 1 and 160
     or p_account_role not in ('admin', 'limited-admin', 'staff', 'teacher')
     or (p_account_role = 'admin' and lower(canonical_name) not in ('nixon', 'ops admin')) then
    raise exception using errcode = '22023', message = 'invalid_legacy_account_identity';
  end if;

  select * into saved
  from internal.app_accounts a
  where a.identity_key = expected_identity
  for update;
  if saved.account_id is null then
    insert into internal.app_accounts (
      identity_key, account_name, account_role, status, super_admin,
      created_by, updated_by
    ) values (
      expected_identity, canonical_name, p_account_role, 'active',
      lower(canonical_name) = 'nixon' and p_account_role = 'admin',
      'legacy-adapter', 'legacy-adapter'
    ) returning * into saved;
    audit_id := internal.append_operational_contract_audit(
      'account.legacy_directory_created', 'legacy-adapter', 'account', saved.account_id::text,
      jsonb_build_object('accountRole', saved.account_role)
    );
  end if;

  update internal.app_account_credentials c
  set account_id = saved.account_id
  where c.identity_key = saved.identity_key
    and c.account_id is distinct from saved.account_id;

  select * into credential
  from internal.app_account_credentials c
  where c.account_id = saved.account_id;
  return query
  select saved.account_id, saved.identity_key, saved.account_name, saved.account_role, saved.status,
    saved.super_admin, saved.access_version, saved.role_version, saved.scope_version,
    credential.credential_version, credential.must_change_password,
    coalesce((select m.enabled from internal.app_account_mfa m where m.account_id = saved.account_id), false),
    saved.legacy_session_allowed, saved.created_at, saved.updated_at, saved.updated_by;
end;
$$;

-- Server-computed role, permissions, and scope.  The actor may read itself;
-- only a stored super-admin may read another account's authorization.
create or replace function public.read_account_authorization(
  p_secret text,
  p_account_id uuid,
  p_actor_account_id uuid
)
returns table (
  account_id uuid,
  account_role text,
  super_admin boolean,
  access_version bigint,
  role_version bigint,
  scope_version bigint,
  permissions text[],
  scope_members jsonb
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  target internal.app_accounts%rowtype;
  actor internal.app_accounts%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select * into target from internal.app_accounts where internal.app_accounts.account_id = p_account_id;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id;
  if target.account_id is null or actor.account_id is null or actor.status <> 'active'
     or (actor.account_id <> target.account_id and not actor.super_admin) then
    raise exception using errcode = '42501', message = 'account_authorization_forbidden';
  end if;
  return query
  select target.account_id, target.account_role, target.super_admin,
    target.access_version, target.role_version, target.scope_version,
    internal.app_account_effective_permissions(target.account_id, target.account_role, target.super_admin),
    internal.app_account_effective_scope(target.account_id, target.account_role, target.super_admin);
end;
$$;

create or replace function public.create_account_invite(
  p_secret text,
  p_command_key text,
  p_identity_key text,
  p_account_name text,
  p_account_role text,
  p_token_hash text,
  p_actor_account_id uuid,
  p_permission_overrides jsonb default '{}'::jsonb,
  p_scope_members jsonb default '[]'::jsonb
)
returns table (
  account_id uuid,
  account_name text,
  account_role text,
  status text,
  role_version bigint,
  scope_version bigint,
  access_version bigint,
  expires_at timestamptz,
  delivery_status text,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor internal.app_accounts%rowtype;
  target internal.app_accounts%rowtype;
  prior internal.app_account_commands%rowtype;
  invite internal.app_account_invites%rowtype;
  audit_id uuid;
  command_digest text;
  canonical_name text;
  expected_identity text;
  override_item record;
  scope_item record;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  canonical_name := trim(p_account_name);
  expected_identity := internal.app_account_identity_key(canonical_name, p_account_role);
  if coalesce(p_command_key, '') !~ '^account-invite:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_identity_key <> expected_identity
     or length(canonical_name) not between 1 and 160
     or p_account_role not in ('admin', 'limited-admin', 'staff', 'teacher')
     or coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_permission_overrides) <> 'object'
     or jsonb_typeof(p_scope_members) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_account_invite';
  end if;
  if exists (
    select 1 from jsonb_each(p_permission_overrides) item
    where item.key !~ '^[a-z][a-z0-9_.:-]{0,79}$' or jsonb_typeof(item.value) <> 'boolean'
  ) or exists (
    select 1 from jsonb_array_elements(p_scope_members) item
    where jsonb_typeof(item) <> 'object'
      or item - 'kind' - 'key' <> '{}'::jsonb
      or item ->> 'kind' not in ('student', 'teacher', 'entity')
      or length(trim(item ->> 'key')) not between 1 and 240
  ) then
    raise exception using errcode = '22023', message = 'invalid_account_access_shape';
  end if;

  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id for update;
  if actor.account_id is null or actor.status <> 'active' or not actor.super_admin then
    raise exception using errcode = '42501', message = 'account_invite_forbidden';
  end if;
  command_digest := encode(extensions.digest(jsonb_build_object(
    'identityKey', p_identity_key, 'accountName', canonical_name, 'accountRole', p_account_role,
    'tokenHash', p_token_hash, 'permissionOverrides', p_permission_overrides,
    'scopeMembers', p_scope_members, 'actorAccountId', p_actor_account_id
  )::text, 'sha256'), 'hex');
  select * into prior from internal.app_account_commands c where c.command_key = lower(p_command_key);
  if prior.command_key is not null then
    if prior.command_hash <> command_digest or prior.action <> 'invite' or prior.actor_account_id <> actor.account_id then
      raise exception using errcode = '23505', message = 'account_command_idempotency_conflict';
    end if;
    select * into invite from internal.app_account_invites i where i.command_key = prior.command_key;
    select * into target from internal.app_accounts a where a.account_id = prior.account_id;
    return query select target.account_id, target.account_name, target.account_role, target.status,
      target.role_version, target.scope_version, target.access_version, invite.expires_at,
      invite.delivery_status, prior.audit_id;
    return;
  end if;

  if exists (select 1 from internal.app_accounts a where a.identity_key = p_identity_key) then
    raise exception using errcode = '23505', message = 'account_identity_already_exists';
  end if;
  insert into internal.app_accounts (
    identity_key, account_name, account_role, status, super_admin,
    created_by, updated_by
  ) values (
    p_identity_key, canonical_name, p_account_role, 'invited', false,
    actor.account_name, actor.account_name
  ) returning * into target;

  insert into internal.app_account_permission_overrides(account_id, permission, allowed, updated_by)
  select target.account_id, item.key, item.value::boolean, actor.account_name
  from jsonb_each(p_permission_overrides) item;
  insert into internal.app_account_scope_members(account_id, scope_kind, scope_key, updated_by)
  select target.account_id, item ->> 'kind', trim(item ->> 'key'), actor.account_name
  from jsonb_array_elements(p_scope_members) item;

  audit_id := internal.append_operational_contract_audit(
    'account.invited', actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('accountRole', target.account_role, 'deliveryStatus', 'delivery_unconfigured')
  );
  insert into internal.app_account_commands(
    command_key, command_hash, action, account_id, actor_account_id, audit_id
  ) values (lower(p_command_key), command_digest, 'invite', target.account_id, actor.account_id, audit_id);
  insert into internal.app_account_invites(
    command_key, account_id, token_hash, expires_at, delivery_status, created_by, audit_id
  ) values (
    lower(p_command_key), target.account_id, p_token_hash, now() + interval '24 hours',
    'delivery_unconfigured', actor.account_id, audit_id
  ) returning * into invite;
  return query select target.account_id, target.account_name, target.account_role, target.status,
    target.role_version, target.scope_version, target.access_version, invite.expires_at,
    invite.delivery_status, audit_id;
end;
$$;

create or replace function public.accept_account_invite(
  p_secret text,
  p_command_key text,
  p_token_hash text,
  p_password_algorithm text,
  p_password_hash text,
  p_password_salt text
)
returns table (
  account_id uuid,
  account_name text,
  account_role text,
  status text,
  credential_version bigint,
  access_version bigint,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite internal.app_account_invites%rowtype;
  target internal.app_accounts%rowtype;
  credential internal.app_account_credentials%rowtype;
  prior internal.app_account_commands%rowtype;
  audit_id uuid;
  command_digest text;
  next_credential_version bigint;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^account-invite-accept:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$'
     or p_password_algorithm <> 'scrypt-v1'
     or coalesce(p_password_hash, '') !~ '^[a-f0-9]{128}$'
     or coalesce(p_password_salt, '') !~ '^[a-f0-9]{32}$' then
    raise exception using errcode = '22023', message = 'invalid_account_invite_accept';
  end if;
  command_digest := encode(extensions.digest(jsonb_build_object(
    'tokenHash', p_token_hash, 'passwordAlgorithm', p_password_algorithm,
    'passwordHash', p_password_hash, 'passwordSalt', p_password_salt
  )::text, 'sha256'), 'hex');
  select * into prior from internal.app_account_commands c where c.command_key = lower(p_command_key);
  if prior.command_key is not null then
    if prior.command_hash <> command_digest or prior.action <> 'invite_accept' then
      raise exception using errcode = '23505', message = 'account_command_idempotency_conflict';
    end if;
    select * into target from internal.app_accounts a where a.account_id = prior.account_id;
    select * into credential from internal.app_account_credentials c where c.account_id = target.account_id;
    return query select target.account_id, target.account_name, target.account_role, target.status,
      credential.credential_version, target.access_version, prior.audit_id;
    return;
  end if;

  select * into invite
  from internal.app_account_invites i
  where i.token_hash = p_token_hash
  for update;
  if invite.invite_id is null or invite.consumed_at is not null or invite.expires_at <= now() then
    raise exception using errcode = '40101', message = 'invalid_or_expired_account_invite';
  end if;
  select * into target from internal.app_accounts a where a.account_id = invite.account_id for update;
  if target.account_id is null or target.status <> 'invited' then
    raise exception using errcode = '40101', message = 'invalid_or_expired_account_invite';
  end if;
  select * into credential from internal.app_account_credentials c where c.account_id = target.account_id for update;
  if credential.account_id is not null then
    raise exception using errcode = '23505', message = 'account_invite_already_accepted';
  end if;
  insert into internal.app_account_credentials(
    identity_key, account_id, account_name, account_role, password_algorithm,
    password_hash, password_salt, credential_version, must_change_password, enabled, updated_by
  ) values (
    target.identity_key, target.account_id, target.account_name, target.account_role, p_password_algorithm,
    p_password_hash, p_password_salt, 1, false, true, target.account_name
  ) returning * into credential;
  update internal.app_accounts a
  set status = 'active', access_version = a.access_version + 1,
    legacy_session_allowed = false, updated_at = now(), updated_by = target.account_name
  where a.account_id = target.account_id
  returning * into target;
  update internal.app_account_invites i set consumed_at = now() where i.invite_id = invite.invite_id;
  update internal.app_account_sessions s
  set revoked_at = now(), revoke_reason = 'invite_accepted'
  where s.account_id = target.account_id and s.revoked_at is null;
  audit_id := internal.append_operational_contract_audit(
    'account.invite_accepted', target.account_name, 'account', target.account_id::text,
    jsonb_build_object('credentialVersion', credential.credential_version)
  );
  insert into internal.app_account_commands(
    command_key, command_hash, action, account_id, result_version, audit_id
  ) values (lower(p_command_key), command_digest, 'invite_accept', target.account_id, credential.credential_version, audit_id);
  return query select target.account_id, target.account_name, target.account_role, target.status,
    credential.credential_version, target.access_version, audit_id;
end;
$$;

-- Password rotation deliberately lives in a separate RPC from status.  It
-- never re-enables a disabled account; the old compatibility RPC remains
-- available for its historical contract but is not used by the new routes.
create or replace function public.rotate_account_password_tx(
  p_secret text,
  p_command_key text,
  p_account_id uuid,
  p_password_algorithm text,
  p_password_hash text,
  p_password_salt text,
  p_expected_credential_version bigint,
  p_must_change_password boolean,
  p_action text,
  p_actor_account_id uuid
)
returns table (
  command_key text,
  applied boolean,
  identity_key text,
  credential_version bigint,
  must_change_password boolean,
  enabled boolean,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target internal.app_accounts%rowtype;
  actor internal.app_accounts%rowtype;
  credential internal.app_account_credentials%rowtype;
  prior internal.app_account_commands%rowtype;
  audit_id uuid;
  command_digest text;
  next_version bigint;
  next_enabled boolean;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^account-password:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_account_id is null or p_password_algorithm <> 'scrypt-v1'
     or coalesce(p_password_hash, '') !~ '^[a-f0-9]{128}$'
     or coalesce(p_password_salt, '') !~ '^[a-f0-9]{32}$'
     or p_expected_credential_version is null or p_expected_credential_version < 0
     or p_must_change_password is null or p_action not in ('self_change', 'admin_reset')
     or p_actor_account_id is null then
    raise exception using errcode = '22023', message = 'invalid_account_password_rotation';
  end if;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id for update;
  select * into target from internal.app_accounts where internal.app_accounts.account_id = p_account_id for update;
  if actor.account_id is null or target.account_id is null or actor.status <> 'active' then
    raise exception using errcode = '42501', message = 'account_password_forbidden';
  end if;
  if p_action = 'self_change' and (actor.account_id <> target.account_id or target.status <> 'active') then
    raise exception using errcode = '42501', message = 'account_password_forbidden';
  end if;
  if p_action = 'admin_reset' and (not actor.super_admin or actor.account_id = target.account_id or target.super_admin) then
    raise exception using errcode = '42501', message = 'account_password_reset_forbidden';
  end if;
  command_digest := encode(extensions.digest(jsonb_build_object(
    'accountId', p_account_id, 'passwordAlgorithm', p_password_algorithm,
    'passwordHash', p_password_hash, 'passwordSalt', p_password_salt,
    'expectedCredentialVersion', p_expected_credential_version,
    'mustChangePassword', p_must_change_password, 'action', p_action,
    'actorAccountId', p_actor_account_id
  )::text, 'sha256'), 'hex');
  select * into prior from internal.app_account_commands c where c.command_key = lower(p_command_key);
  if prior.command_key is not null then
    if prior.command_hash <> command_digest or prior.action <> p_action or prior.account_id <> target.account_id
       or prior.actor_account_id <> actor.account_id then
      raise exception using errcode = '23505', message = 'account_command_idempotency_conflict';
    end if;
    select * into credential from internal.app_account_credentials c where c.account_id = target.account_id;
    return query select prior.command_key, false, target.identity_key, credential.credential_version,
      credential.must_change_password, credential.enabled, prior.audit_id;
    return;
  end if;

  select * into credential from internal.app_account_credentials c where c.account_id = target.account_id for update;
  if credential.account_id is null then
    if p_expected_credential_version <> 0 then
      raise exception using errcode = '40001', message = 'account_credential_version_conflict';
    end if;
    next_version := 1;
    insert into internal.app_account_credentials(
      identity_key, account_id, account_name, account_role, password_algorithm,
      password_hash, password_salt, credential_version, must_change_password, enabled, updated_by
    ) values (
      target.identity_key, target.account_id, target.account_name, target.account_role, p_password_algorithm,
      p_password_hash, p_password_salt, next_version, p_must_change_password,
      target.status <> 'disabled', actor.account_name
    ) returning * into credential;
  else
    if credential.identity_key <> target.identity_key
       or credential.account_name <> target.account_name
       or credential.account_role <> target.account_role then
      raise exception using errcode = '23505', message = 'account_credential_identity_conflict';
    end if;
    if credential.credential_version <> p_expected_credential_version then
      raise exception using errcode = '40001', message = 'account_credential_version_conflict';
    end if;
    next_version := credential.credential_version + 1;
    update internal.app_account_credentials c
    set password_algorithm = p_password_algorithm, password_hash = p_password_hash,
      password_salt = p_password_salt, credential_version = next_version,
      must_change_password = p_must_change_password,
      enabled = target.status <> 'disabled', password_changed_at = now(),
      updated_at = now(), updated_by = actor.account_name
    where c.account_id = target.account_id
    returning * into credential;
  end if;
  next_enabled := credential.enabled;
  update internal.app_accounts a
  set access_version = a.access_version + 1, legacy_session_allowed = false,
    updated_at = now(), updated_by = actor.account_name
  where a.account_id = target.account_id
  returning * into target;
  update internal.app_account_sessions s
  set revoked_at = now(), revoke_reason = case when p_action = 'admin_reset' then 'admin_password_reset' else 'password_changed' end
  where s.account_id = target.account_id and s.revoked_at is null;
  audit_id := internal.append_operational_contract_audit(
    case when p_action = 'admin_reset' then 'account.password_reset' else 'account.password_changed' end,
    actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('credentialVersion', credential.credential_version, 'mustChangePassword', credential.must_change_password)
  );
  insert into internal.app_account_commands(
    command_key, command_hash, action, account_id, actor_account_id, result_version, audit_id
  ) values (lower(p_command_key), command_digest, p_action, target.account_id, actor.account_id, credential.credential_version, audit_id);
  return query select lower(p_command_key), true, target.identity_key, credential.credential_version,
    credential.must_change_password, next_enabled, audit_id;
end;
$$;

create or replace function public.set_account_status(
  p_secret text,
  p_command_key text,
  p_account_id uuid,
  p_status text,
  p_expected_access_version bigint,
  p_actor_account_id uuid
)
returns table (
  account_id uuid,
  status text,
  access_version bigint,
  revoked_session_count integer,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor internal.app_accounts%rowtype;
  target internal.app_accounts%rowtype;
  prior internal.app_account_commands%rowtype;
  audit_id uuid;
  command_digest text;
  revoked_count integer := 0;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^account-status:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_account_id is null or p_status not in ('active', 'disabled')
     or p_expected_access_version is null or p_expected_access_version < 1
     or p_actor_account_id is null then
    raise exception using errcode = '22023', message = 'invalid_account_status_command';
  end if;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id for update;
  select * into target from internal.app_accounts where internal.app_accounts.account_id = p_account_id for update;
  if actor.account_id is null or target.account_id is null or actor.status <> 'active' or not actor.super_admin then
    raise exception using errcode = '42501', message = 'account_status_forbidden';
  end if;
  if target.super_admin and (p_status <> 'active' or target.account_name <> 'Nixon' or target.account_role <> 'admin') then
    raise exception using errcode = '42501', message = 'super_admin_immutable';
  end if;
  command_digest := encode(extensions.digest(jsonb_build_object(
    'accountId', p_account_id, 'status', p_status, 'expectedAccessVersion', p_expected_access_version,
    'actorAccountId', p_actor_account_id
  )::text, 'sha256'), 'hex');
  select * into prior from internal.app_account_commands c where c.command_key = lower(p_command_key);
  if prior.command_key is not null then
    if prior.command_hash <> command_digest or prior.action <> 'status' or prior.account_id <> target.account_id
       or prior.actor_account_id <> actor.account_id then
      raise exception using errcode = '23505', message = 'account_command_idempotency_conflict';
    end if;
    return query select target.account_id, target.status, target.access_version, 0, prior.audit_id;
    return;
  end if;
  if target.access_version <> p_expected_access_version then
    raise exception using errcode = '40001', message = 'account_access_version_conflict';
  end if;
  update internal.app_accounts a
  set status = p_status, access_version = a.access_version + 1,
    legacy_session_allowed = false, updated_at = now(), updated_by = actor.account_name
  where a.account_id = target.account_id
  returning * into target;
  update internal.app_account_sessions s
  set revoked_at = now(), revoke_reason = case when p_status = 'disabled' then 'account_disabled' else 'account_restored' end
  where s.account_id = target.account_id and s.revoked_at is null;
  get diagnostics revoked_count = row_count;
  audit_id := internal.append_operational_contract_audit(
    case when p_status = 'disabled' then 'account.disabled' else 'account.restored' end,
    actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('status', target.status, 'accessVersion', target.access_version)
  );
  insert into internal.app_account_commands(
    command_key, command_hash, action, account_id, actor_account_id, result_version, audit_id
  ) values (lower(p_command_key), command_digest, 'status', target.account_id, actor.account_id, target.access_version, audit_id);
  return query select target.account_id, target.status, target.access_version, revoked_count, audit_id;
end;
$$;

create or replace function public.update_account_access(
  p_secret text,
  p_command_key text,
  p_account_id uuid,
  p_account_role text,
  p_permission_overrides jsonb,
  p_scope_members jsonb,
  p_expected_role_version bigint,
  p_expected_scope_version bigint,
  p_actor_account_id uuid
)
returns table (
  account_id uuid,
  account_role text,
  status text,
  role_version bigint,
  scope_version bigint,
  access_version bigint,
  permissions text[],
  scope_members jsonb,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor internal.app_accounts%rowtype;
  target internal.app_accounts%rowtype;
  prior internal.app_account_commands%rowtype;
  audit_id uuid;
  command_digest text;
  next_role_version bigint;
  next_scope_version bigint;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^account-access:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_account_id is null or p_account_role not in ('admin', 'limited-admin', 'staff', 'teacher')
     or jsonb_typeof(p_permission_overrides) <> 'object' or jsonb_typeof(p_scope_members) <> 'array'
     or p_expected_role_version is null or p_expected_role_version < 1
     or p_expected_scope_version is null or p_expected_scope_version < 1
     or p_actor_account_id is null then
    raise exception using errcode = '22023', message = 'invalid_account_access_command';
  end if;
  if exists (
    select 1 from jsonb_each(p_permission_overrides) item
    where item.key !~ '^[a-z][a-z0-9_.:-]{0,79}$' or jsonb_typeof(item.value) <> 'boolean'
  ) or exists (
    select 1 from jsonb_array_elements(p_scope_members) item
    where jsonb_typeof(item) <> 'object'
      or item - 'kind' - 'key' <> '{}'::jsonb
      or item ->> 'kind' not in ('student', 'teacher', 'entity')
      or length(trim(item ->> 'key')) not between 1 and 240
  ) then
    raise exception using errcode = '22023', message = 'invalid_account_access_shape';
  end if;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id for update;
  select * into target from internal.app_accounts where internal.app_accounts.account_id = p_account_id for update;
  if actor.account_id is null or target.account_id is null or actor.status <> 'active' or not actor.super_admin then
    raise exception using errcode = '42501', message = 'account_access_forbidden';
  end if;
  if target.super_admin and (
    p_account_role <> 'admin'
    or exists (select 1 from jsonb_each(p_permission_overrides) item where item.value::boolean = false)
    or jsonb_array_length(p_scope_members) <> 0
  ) then
    raise exception using errcode = '42501', message = 'super_admin_immutable';
  end if;
  command_digest := encode(extensions.digest(jsonb_build_object(
    'accountId', p_account_id, 'accountRole', p_account_role,
    'permissionOverrides', p_permission_overrides, 'scopeMembers', p_scope_members,
    'expectedRoleVersion', p_expected_role_version, 'expectedScopeVersion', p_expected_scope_version,
    'actorAccountId', p_actor_account_id
  )::text, 'sha256'), 'hex');
  select * into prior from internal.app_account_commands c where c.command_key = lower(p_command_key);
  if prior.command_key is not null then
    if prior.command_hash <> command_digest or prior.action <> 'access' or prior.account_id <> target.account_id
       or prior.actor_account_id <> actor.account_id then
      raise exception using errcode = '23505', message = 'account_command_idempotency_conflict';
    end if;
    return query select target.account_id, target.account_role, target.status, target.role_version,
      target.scope_version, target.access_version,
      internal.app_account_effective_permissions(target.account_id, target.account_role, target.super_admin),
      internal.app_account_effective_scope(target.account_id, target.account_role, target.super_admin), prior.audit_id;
    return;
  end if;
  if target.role_version <> p_expected_role_version or target.scope_version <> p_expected_scope_version then
    raise exception using errcode = '40001', message = 'account_access_version_conflict';
  end if;
  next_role_version := target.role_version + case when target.account_role = p_account_role then 0 else 1 end;
  next_scope_version := target.scope_version + 1;
  if target.super_admin then
    -- Only a no-op role/empty-scope update can arrive here.
    next_role_version := target.role_version;
    next_scope_version := target.scope_version;
  end if;
  update internal.app_accounts a
  set account_role = p_account_role, role_version = next_role_version,
    scope_version = next_scope_version, access_version = a.access_version + 1,
    legacy_session_allowed = false, updated_at = now(), updated_by = actor.account_name
  where a.account_id = target.account_id
  returning * into target;
  delete from internal.app_account_permission_overrides where account_id = target.account_id;
  insert into internal.app_account_permission_overrides(account_id, permission, allowed, updated_by)
  select target.account_id, item.key, item.value::boolean, actor.account_name
  from jsonb_each(p_permission_overrides) item;
  delete from internal.app_account_scope_members where account_id = target.account_id;
  insert into internal.app_account_scope_members(account_id, scope_kind, scope_key, updated_by)
  select target.account_id, item ->> 'kind', trim(item ->> 'key'), actor.account_name
  from jsonb_array_elements(p_scope_members) item;
  update internal.app_account_sessions s
  set revoked_at = now(), revoke_reason = 'account_access_changed'
  where s.account_id = target.account_id and s.revoked_at is null;
  audit_id := internal.append_operational_contract_audit(
    'account.access_changed', actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('accountRole', target.account_role, 'roleVersion', target.role_version, 'scopeVersion', target.scope_version)
  );
  insert into internal.app_account_commands(
    command_key, command_hash, action, account_id, actor_account_id, result_version, audit_id
  ) values (lower(p_command_key), command_digest, 'access', target.account_id, actor.account_id, target.access_version, audit_id);
  return query select target.account_id, target.account_role, target.status, target.role_version,
    target.scope_version, target.access_version,
    internal.app_account_effective_permissions(target.account_id, target.account_role, target.super_admin),
    internal.app_account_effective_scope(target.account_id, target.account_role, target.super_admin), audit_id;
end;
$$;

create or replace function public.create_account_session(
  p_secret text,
  p_session_id uuid,
  p_token_hash text,
  p_account_id uuid,
  p_mfa_verified boolean,
  p_user_agent text default null
)
returns table (
  session_id uuid,
  account_id uuid,
  absolute_expires_at timestamptz,
  idle_expires_at timestamptz,
  access_version bigint,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target internal.app_accounts%rowtype;
  mfa_enabled boolean := false;
  saved internal.app_account_sessions%rowtype;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_session_id is null or coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$'
     or p_account_id is null or p_mfa_verified is null
     or (p_user_agent is not null and length(p_user_agent) > 512) then
    raise exception using errcode = '22023', message = 'invalid_account_session';
  end if;
  select * into target from internal.app_accounts where internal.app_accounts.account_id = p_account_id for update;
  select coalesce(m.enabled, false) into mfa_enabled from internal.app_account_mfa m where m.account_id = target.account_id;
  if target.account_id is null or target.status <> 'active' then
    raise exception using errcode = '42501', message = 'account_session_forbidden';
  end if;
  if mfa_enabled and not p_mfa_verified then
    raise exception using errcode = '42501', message = 'mfa_required';
  end if;
  insert into internal.app_account_sessions(
    session_id, account_id, token_hash, absolute_expires_at, idle_expires_at,
    user_agent, mfa_verified, access_version
  ) values (
    p_session_id, target.account_id, p_token_hash, now() + interval '30 days',
    now() + interval '12 hours', nullif(trim(p_user_agent), ''), p_mfa_verified, target.access_version
  ) returning * into saved;
  audit_id := internal.append_operational_contract_audit(
    'account.session_created', target.account_name, 'account', target.account_id::text,
    jsonb_build_object('mfaVerified', p_mfa_verified, 'absoluteExpiresAt', saved.absolute_expires_at)
  );
  return query select saved.session_id, saved.account_id, saved.absolute_expires_at,
    saved.idle_expires_at, saved.access_version, audit_id;
end;
$$;

create or replace function public.read_account_session(
  p_secret text,
  p_token_hash text
)
returns table (
  session_id uuid,
  account_id uuid,
  account_name text,
  account_role text,
  status text,
  super_admin boolean,
  access_version bigint,
  role_version bigint,
  scope_version bigint,
  credential_version bigint,
  must_change_password boolean,
  mfa_verified boolean,
  permissions text[],
  scope_members jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved internal.app_account_sessions%rowtype;
  target internal.app_accounts%rowtype;
  credential internal.app_account_credentials%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_account_session_token';
  end if;
  select * into saved from internal.app_account_sessions s where s.token_hash = p_token_hash for update;
  if saved.session_id is null then return; end if;
  select * into target from internal.app_accounts a where a.account_id = saved.account_id for update;
  if target.account_id is null or saved.revoked_at is not null or target.status <> 'active'
     or saved.absolute_expires_at <= now() or saved.idle_expires_at <= now()
     or saved.access_version <> target.access_version then
    update internal.app_account_sessions s
    set revoked_at = coalesce(s.revoked_at, now()), revoke_reason = coalesce(s.revoke_reason, 'session_expired_or_stale')
    where s.session_id = saved.session_id;
    return;
  end if;
  update internal.app_account_sessions s
  set last_seen_at = now(), idle_expires_at = least(s.absolute_expires_at, now() + interval '12 hours')
  where s.session_id = saved.session_id
  returning * into saved;
  select * into credential from internal.app_account_credentials c where c.account_id = target.account_id;
  return query select saved.session_id, target.account_id, target.account_name, target.account_role,
    target.status, target.super_admin, target.access_version, target.role_version, target.scope_version,
    credential.credential_version, credential.must_change_password, saved.mfa_verified,
    internal.app_account_effective_permissions(target.account_id, target.account_role, target.super_admin),
    internal.app_account_effective_scope(target.account_id, target.account_role, target.super_admin);
end;
$$;

create or replace function public.read_account_sessions(
  p_secret text,
  p_actor_account_id uuid,
  p_target_account_id uuid,
  p_current_session_id uuid default null
)
returns table (
  session_id uuid,
  created_at timestamptz,
  last_seen_at timestamptz,
  absolute_expires_at timestamptz,
  idle_expires_at timestamptz,
  mfa_verified boolean,
  current boolean
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare actor internal.app_accounts%rowtype;
declare target internal.app_accounts%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id;
  select * into target from internal.app_accounts where internal.app_accounts.account_id = p_target_account_id;
  if actor.account_id is null or target.account_id is null or actor.status <> 'active'
     or (actor.account_id <> target.account_id and not actor.super_admin) then
    raise exception using errcode = '42501', message = 'account_sessions_forbidden';
  end if;
  return query
  select s.session_id, s.created_at, s.last_seen_at, s.absolute_expires_at,
    s.idle_expires_at, s.mfa_verified, s.session_id = p_current_session_id
  from internal.app_account_sessions s
  where s.account_id = target.account_id and s.revoked_at is null
    and s.absolute_expires_at > now() and s.idle_expires_at > now()
  order by s.created_at desc, s.session_id;
end;
$$;

create or replace function public.revoke_account_sessions(
  p_secret text,
  p_actor_account_id uuid,
  p_target_account_id uuid,
  p_token_hash text default null,
  p_revoke_all boolean default false
)
returns table (
  revoked_session_count integer,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor internal.app_accounts%rowtype;
  target internal.app_accounts%rowtype;
  revoked_count integer := 0;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor_account_id is null or p_target_account_id is null or p_revoke_all is null then
    raise exception using errcode = '22023', message = 'invalid_account_session_revoke';
  end if;
  if not p_revoke_all and coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_account_session_token';
  end if;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id;
  select * into target from internal.app_accounts where internal.app_accounts.account_id = p_target_account_id;
  if actor.account_id is null or target.account_id is null or actor.status <> 'active'
     or (actor.account_id <> target.account_id and not actor.super_admin) then
    raise exception using errcode = '42501', message = 'account_sessions_forbidden';
  end if;
  if p_revoke_all then
    update internal.app_account_sessions s
    set revoked_at = now(), revoke_reason = 'explicit_revoke_all'
    where s.account_id = target.account_id and s.revoked_at is null;
  else
    update internal.app_account_sessions s
    set revoked_at = now(), revoke_reason = 'explicit_revoke_current'
    where s.account_id = target.account_id and s.token_hash = p_token_hash and s.revoked_at is null;
  end if;
  get diagnostics revoked_count = row_count;
  audit_id := internal.append_operational_contract_audit(
    case when p_revoke_all then 'account.sessions_revoked_all' else 'account.session_revoked' end,
    actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('revokedSessionCount', revoked_count)
  );
  return query select revoked_count, audit_id;
end;
$$;

create or replace function public.issue_account_recovery(
  p_secret text,
  p_identity_key text,
  p_token_hash text
)
returns table (
  accepted boolean,
  expires_at timestamptz,
  delivery_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target internal.app_accounts%rowtype;
  audit_id uuid;
  expiry timestamptz;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_identity_key, '') !~ '^[a-f0-9]{64}$' or coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_account_recovery_request';
  end if;
  select * into target from internal.app_accounts where internal.app_accounts.identity_key = p_identity_key;
  if target.account_id is null or target.status <> 'active' then
    return query select false, null::timestamptz, null::text;
    return;
  end if;
  update internal.app_account_recovery_tokens r
  set consumed_at = coalesce(r.consumed_at, now())
  where r.account_id = target.account_id and r.consumed_at is null;
  expiry := now() + interval '30 minutes';
  audit_id := internal.append_operational_contract_audit(
    'account.password_recovery_requested', 'recovery-request', 'account', target.account_id::text,
    jsonb_build_object('deliveryStatus', 'delivery_unconfigured')
  );
  insert into internal.app_account_recovery_tokens(account_id, token_hash, expires_at, audit_id)
  values (target.account_id, p_token_hash, expiry, audit_id);
  return query select true, expiry, 'delivery_unconfigured';
end;
$$;

create or replace function public.consume_account_recovery(
  p_secret text,
  p_command_key text,
  p_token_hash text,
  p_password_algorithm text,
  p_password_hash text,
  p_password_salt text
)
returns table (
  account_id uuid,
  account_name text,
  account_role text,
  credential_version bigint,
  access_version bigint,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  recovery internal.app_account_recovery_tokens%rowtype;
  target internal.app_accounts%rowtype;
  credential internal.app_account_credentials%rowtype;
  prior internal.app_account_commands%rowtype;
  audit_id uuid;
  command_digest text;
  next_version bigint;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^account-recovery:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$'
     or p_password_algorithm <> 'scrypt-v1'
     or coalesce(p_password_hash, '') !~ '^[a-f0-9]{128}$'
     or coalesce(p_password_salt, '') !~ '^[a-f0-9]{32}$' then
    raise exception using errcode = '22023', message = 'invalid_account_recovery';
  end if;
  command_digest := encode(extensions.digest(jsonb_build_object(
    'tokenHash', p_token_hash, 'passwordAlgorithm', p_password_algorithm,
    'passwordHash', p_password_hash, 'passwordSalt', p_password_salt
  )::text, 'sha256'), 'hex');
  select * into prior from internal.app_account_commands c where c.command_key = lower(p_command_key);
  if prior.command_key is not null then
    if prior.command_hash <> command_digest or prior.action <> 'recovery' then
      raise exception using errcode = '23505', message = 'account_command_idempotency_conflict';
    end if;
    select * into target from internal.app_accounts a where a.account_id = prior.account_id;
    select * into credential from internal.app_account_credentials c where c.account_id = target.account_id;
    return query select target.account_id, target.account_name, target.account_role,
      credential.credential_version, target.access_version, prior.audit_id;
    return;
  end if;
  select * into recovery
  from internal.app_account_recovery_tokens r
  where r.token_hash = p_token_hash
  for update;
  if recovery.recovery_id is null or recovery.consumed_at is not null or recovery.expires_at <= now() then
    raise exception using errcode = '40101', message = 'invalid_or_expired_account_recovery';
  end if;
  select * into target from internal.app_accounts a where a.account_id = recovery.account_id for update;
  if target.account_id is null or target.status <> 'active' then
    raise exception using errcode = '40101', message = 'invalid_or_expired_account_recovery';
  end if;
  select * into credential from internal.app_account_credentials c where c.account_id = target.account_id for update;
  if credential.account_id is null then
    next_version := 1;
    insert into internal.app_account_credentials(
      identity_key, account_id, account_name, account_role, password_algorithm,
      password_hash, password_salt, credential_version, must_change_password, enabled, updated_by
    ) values (
      target.identity_key, target.account_id, target.account_name, target.account_role, p_password_algorithm,
      p_password_hash, p_password_salt, next_version, false, true, target.account_name
    ) returning * into credential;
  else
    next_version := credential.credential_version + 1;
    update internal.app_account_credentials c
    set password_algorithm = p_password_algorithm, password_hash = p_password_hash,
      password_salt = p_password_salt, credential_version = next_version,
      must_change_password = false, enabled = true, password_changed_at = now(),
      updated_at = now(), updated_by = target.account_name
    where c.account_id = target.account_id
    returning * into credential;
  end if;
  update internal.app_account_recovery_tokens r set consumed_at = now() where r.recovery_id = recovery.recovery_id;
  update internal.app_account_recovery_tokens r
  set consumed_at = coalesce(r.consumed_at, now())
  where r.account_id = target.account_id and r.consumed_at is null;
  update internal.app_accounts a
  set access_version = a.access_version + 1, legacy_session_allowed = false,
    updated_at = now(), updated_by = target.account_name
  where a.account_id = target.account_id
  returning * into target;
  update internal.app_account_sessions s
  set revoked_at = now(), revoke_reason = 'password_recovered'
  where s.account_id = target.account_id and s.revoked_at is null;
  audit_id := internal.append_operational_contract_audit(
    'account.password_recovered', target.account_name, 'account', target.account_id::text,
    jsonb_build_object('credentialVersion', credential.credential_version)
  );
  insert into internal.app_account_commands(
    command_key, command_hash, action, account_id, result_version, audit_id
  ) values (lower(p_command_key), command_digest, 'recovery', target.account_id, credential.credential_version, audit_id);
  return query select target.account_id, target.account_name, target.account_role,
    credential.credential_version, target.access_version, audit_id;
end;
$$;

create or replace function public.read_account_mfa_for_login(
  p_secret text,
  p_identity_key text
)
returns table (
  account_id uuid,
  secret_ciphertext text,
  enabled boolean,
  mfa_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_identity_key, '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_account_identity_key';
  end if;
  return query
  select a.account_id, m.secret_ciphertext, m.enabled, m.mfa_version
  from internal.app_accounts a
  join internal.app_account_mfa m on m.account_id = a.account_id
  where a.identity_key = p_identity_key and a.status = 'active';
end;
$$;

create or replace function public.read_account_mfa(
  p_secret text,
  p_account_id uuid,
  p_actor_account_id uuid
)
returns table (
  account_id uuid,
  secret_ciphertext text,
  enabled boolean,
  mfa_version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare actor internal.app_accounts%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id;
  if actor.account_id is null or actor.status <> 'active'
     or (p_actor_account_id <> p_account_id and not actor.super_admin) then
    raise exception using errcode = '42501', message = 'account_mfa_forbidden';
  end if;
  return query select m.account_id, m.secret_ciphertext, m.enabled, m.mfa_version
  from internal.app_account_mfa m where m.account_id = p_account_id;
end;
$$;

create or replace function public.begin_account_mfa_setup(
  p_secret text,
  p_account_id uuid,
  p_secret_ciphertext text,
  p_expected_mfa_version bigint,
  p_actor_account_id uuid
)
returns table (
  account_id uuid,
  enabled boolean,
  mfa_version bigint,
  access_version bigint,
  revoked_session_count integer,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor internal.app_accounts%rowtype;
  target internal.app_accounts%rowtype;
  mfa internal.app_account_mfa%rowtype;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_account_id is null or coalesce(p_secret_ciphertext, '') !~ '^mfa:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'
     or p_expected_mfa_version is null or p_expected_mfa_version < 0 or p_actor_account_id is null then
    raise exception using errcode = '22023', message = 'invalid_account_mfa_setup';
  end if;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id;
  select * into target from internal.app_accounts where internal.app_accounts.account_id = p_account_id for update;
  if actor.account_id is null or target.account_id is null or actor.status <> 'active'
     or actor.account_id <> target.account_id then
    raise exception using errcode = '42501', message = 'account_mfa_forbidden';
  end if;
  select * into mfa from internal.app_account_mfa m where m.account_id = target.account_id for update;
  if mfa.account_id is null then
    if p_expected_mfa_version <> 0 then
      raise exception using errcode = '40001', message = 'account_mfa_version_conflict';
    end if;
    insert into internal.app_account_mfa(account_id, secret_ciphertext, enabled, mfa_version, updated_by)
    values (target.account_id, p_secret_ciphertext, false, 1, actor.account_name)
    returning * into mfa;
  else
    if mfa.mfa_version <> p_expected_mfa_version then
      raise exception using errcode = '40001', message = 'account_mfa_version_conflict';
    end if;
    update internal.app_account_mfa m
    set secret_ciphertext = p_secret_ciphertext, enabled = false,
      mfa_version = m.mfa_version + 1, updated_at = now(), updated_by = actor.account_name
    where m.account_id = target.account_id
    returning * into mfa;
  end if;
  audit_id := internal.append_operational_contract_audit(
    'account.mfa_setup_started', actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('mfaVersion', mfa.mfa_version)
  );
  return query select target.account_id, mfa.enabled, mfa.mfa_version,
    target.access_version, 0, audit_id;
end;
$$;

create or replace function public.confirm_account_mfa(
  p_secret text,
  p_account_id uuid,
  p_expected_mfa_version bigint,
  p_actor_account_id uuid
)
returns table (
  account_id uuid,
  enabled boolean,
  mfa_version bigint,
  access_version bigint,
  revoked_session_count integer,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor internal.app_accounts%rowtype;
  target internal.app_accounts%rowtype;
  mfa internal.app_account_mfa%rowtype;
  audit_id uuid;
  revoked_count integer := 0;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id;
  select * into target from internal.app_accounts where internal.app_accounts.account_id = p_account_id for update;
  select * into mfa from internal.app_account_mfa m where m.account_id = p_account_id for update;
  if actor.account_id is null or target.account_id is null or mfa.account_id is null
     or actor.account_id <> target.account_id or actor.status <> 'active' or mfa.enabled
     or mfa.mfa_version <> p_expected_mfa_version then
    raise exception using errcode = '40001', message = 'account_mfa_version_conflict';
  end if;
  update internal.app_account_mfa m set enabled = true, updated_at = now(), updated_by = actor.account_name
  where m.account_id = target.account_id returning * into mfa;
  update internal.app_accounts a
  set access_version = a.access_version + 1, legacy_session_allowed = false,
    updated_at = now(), updated_by = actor.account_name
  where a.account_id = target.account_id returning * into target;
  update internal.app_account_sessions s
  set revoked_at = now(), revoke_reason = 'mfa_enabled'
  where s.account_id = target.account_id and s.revoked_at is null;
  get diagnostics revoked_count = row_count;
  audit_id := internal.append_operational_contract_audit(
    'account.mfa_enabled', actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('mfaVersion', mfa.mfa_version)
  );
  return query select target.account_id, mfa.enabled, mfa.mfa_version,
    target.access_version, revoked_count, audit_id;
end;
$$;

create or replace function public.disable_account_mfa(
  p_secret text,
  p_account_id uuid,
  p_expected_mfa_version bigint,
  p_actor_account_id uuid
)
returns table (
  account_id uuid,
  enabled boolean,
  mfa_version bigint,
  access_version bigint,
  revoked_session_count integer,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor internal.app_accounts%rowtype;
  target internal.app_accounts%rowtype;
  mfa internal.app_account_mfa%rowtype;
  audit_id uuid;
  revoked_count integer := 0;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id;
  select * into target from internal.app_accounts where internal.app_accounts.account_id = p_account_id for update;
  select * into mfa from internal.app_account_mfa m where m.account_id = p_account_id for update;
  if actor.account_id is null or target.account_id is null or mfa.account_id is null
     or actor.account_id <> target.account_id or actor.status <> 'active'
     or mfa.mfa_version <> p_expected_mfa_version then
    raise exception using errcode = '40001', message = 'account_mfa_version_conflict';
  end if;
  update internal.app_account_mfa m
  set enabled = false, mfa_version = m.mfa_version + 1, updated_at = now(), updated_by = actor.account_name
  where m.account_id = target.account_id returning * into mfa;
  update internal.app_accounts a
  set access_version = a.access_version + 1, legacy_session_allowed = false,
    updated_at = now(), updated_by = actor.account_name
  where a.account_id = target.account_id returning * into target;
  update internal.app_account_sessions s
  set revoked_at = now(), revoke_reason = 'mfa_disabled'
  where s.account_id = target.account_id and s.revoked_at is null;
  get diagnostics revoked_count = row_count;
  audit_id := internal.append_operational_contract_audit(
    'account.mfa_disabled', actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('mfaVersion', mfa.mfa_version)
  );
  return query select target.account_id, mfa.enabled, mfa.mfa_version,
    target.access_version, revoked_count, audit_id;
end;
$$;

create or replace function public.reset_account_mfa(
  p_secret text,
  p_actor_account_id uuid,
  p_target_account_id uuid
)
returns table (
  account_id uuid,
  enabled boolean,
  mfa_version bigint,
  access_version bigint,
  revoked_session_count integer,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor internal.app_accounts%rowtype;
  target internal.app_accounts%rowtype;
  prior_mfa_version bigint;
  audit_id uuid;
  revoked_count integer := 0;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select * into actor from internal.app_accounts where internal.app_accounts.account_id = p_actor_account_id;
  select * into target from internal.app_accounts where internal.app_accounts.account_id = p_target_account_id for update;
  select m.mfa_version into prior_mfa_version from internal.app_account_mfa m where m.account_id = target.account_id for update;
  if actor.account_id is null or target.account_id is null or actor.status <> 'active' or not actor.super_admin then
    raise exception using errcode = '42501', message = 'account_mfa_reset_forbidden';
  end if;
  delete from internal.app_account_mfa where account_id = target.account_id;
  update internal.app_accounts a
  set access_version = a.access_version + 1, legacy_session_allowed = false,
    updated_at = now(), updated_by = actor.account_name
  where a.account_id = target.account_id returning * into target;
  update internal.app_account_sessions s
  set revoked_at = now(), revoke_reason = 'admin_mfa_reset'
  where s.account_id = target.account_id and s.revoked_at is null;
  get diagnostics revoked_count = row_count;
  audit_id := internal.append_operational_contract_audit(
    'account.mfa_reset', actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('previousMfaVersion', prior_mfa_version)
  );
  return query select target.account_id, false, coalesce(prior_mfa_version, 0) + 1,
    target.access_version, revoked_count, audit_id;
end;
$$;

-- Public Data API roles may invoke only these secret-gated functions.  The
-- tables and all internal helpers remain inaccessible through direct grants.
revoke all on function public.read_account_by_identity(text, text) from public, anon, authenticated;
revoke all on function public.read_account_directory(text, uuid) from public, anon, authenticated;
revoke all on function public.ensure_account_directory(text, text, text, text) from public, anon, authenticated;
revoke all on function public.read_account_authorization(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_account_invite(text, text, text, text, text, text, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.accept_account_invite(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.rotate_account_password_tx(text, text, uuid, text, text, text, bigint, boolean, text, uuid) from public, anon, authenticated;
revoke all on function public.set_account_status(text, text, uuid, text, bigint, uuid) from public, anon, authenticated;
revoke all on function public.update_account_access(text, text, uuid, text, jsonb, jsonb, bigint, bigint, uuid) from public, anon, authenticated;
revoke all on function public.create_account_session(text, uuid, text, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.read_account_session(text, text) from public, anon, authenticated;
revoke all on function public.read_account_sessions(text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.revoke_account_sessions(text, uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.issue_account_recovery(text, text, text) from public, anon, authenticated;
revoke all on function public.consume_account_recovery(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.read_account_mfa_for_login(text, text) from public, anon, authenticated;
revoke all on function public.read_account_mfa(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.begin_account_mfa_setup(text, uuid, text, bigint, uuid) from public, anon, authenticated;
revoke all on function public.confirm_account_mfa(text, uuid, bigint, uuid) from public, anon, authenticated;
revoke all on function public.disable_account_mfa(text, uuid, bigint, uuid) from public, anon, authenticated;
revoke all on function public.reset_account_mfa(text, uuid, uuid) from public, anon, authenticated;

grant execute on function public.read_account_by_identity(text, text) to anon, authenticated;
grant execute on function public.read_account_directory(text, uuid) to anon, authenticated;
grant execute on function public.ensure_account_directory(text, text, text, text) to anon, authenticated;
grant execute on function public.read_account_authorization(text, uuid, uuid) to anon, authenticated;
grant execute on function public.create_account_invite(text, text, text, text, text, text, uuid, jsonb, jsonb) to anon, authenticated;
grant execute on function public.accept_account_invite(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.rotate_account_password_tx(text, text, uuid, text, text, text, bigint, boolean, text, uuid) to anon, authenticated;
grant execute on function public.set_account_status(text, text, uuid, text, bigint, uuid) to anon, authenticated;
grant execute on function public.update_account_access(text, text, uuid, text, jsonb, jsonb, bigint, bigint, uuid) to anon, authenticated;
grant execute on function public.create_account_session(text, uuid, text, uuid, boolean, text) to anon, authenticated;
grant execute on function public.read_account_session(text, text) to anon, authenticated;
grant execute on function public.read_account_sessions(text, uuid, uuid, uuid) to anon, authenticated;
grant execute on function public.revoke_account_sessions(text, uuid, uuid, text, boolean) to anon, authenticated;
grant execute on function public.issue_account_recovery(text, text, text) to anon, authenticated;
grant execute on function public.consume_account_recovery(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.read_account_mfa_for_login(text, text) to anon, authenticated;
grant execute on function public.read_account_mfa(text, uuid, uuid) to anon, authenticated;
grant execute on function public.begin_account_mfa_setup(text, uuid, text, bigint, uuid) to anon, authenticated;
grant execute on function public.confirm_account_mfa(text, uuid, bigint, uuid) to anon, authenticated;
grant execute on function public.disable_account_mfa(text, uuid, bigint, uuid) to anon, authenticated;
grant execute on function public.reset_account_mfa(text, uuid, uuid) to anon, authenticated;

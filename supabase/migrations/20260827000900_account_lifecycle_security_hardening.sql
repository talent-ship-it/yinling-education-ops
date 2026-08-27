-- Forward-only account lifecycle corrections and authentication hardening.
-- The preceding lifecycle migration may already be recorded on a target, so
-- every post-deployment correction lives in this new migration.

update internal.app_accounts a
set status = 'disabled', access_version = a.access_version + 1,
    legacy_session_allowed = false, updated_at = now(), updated_by = 'credential-bridge'
from internal.app_account_credentials c
where c.account_id = a.account_id
  and not c.enabled
  and not a.super_admin
  and a.status <> 'disabled';

-- Authentication throttles store only keyed HMAC digests produced by the
-- server. Raw IP addresses, usernames, passwords and MFA codes never enter
-- the database or audit log.
create table if not exists internal.app_account_auth_throttles (
  throttle_key text primary key check (throttle_key ~ '^[ni]:[a-f0-9]{64}$'),
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  window_started_at timestamptz not null default now(),
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists app_account_auth_throttles_blocked_idx
  on internal.app_account_auth_throttles(blocked_until) where blocked_until is not null;
create index if not exists app_account_auth_throttles_updated_idx
  on internal.app_account_auth_throttles(updated_at);
alter table internal.app_account_auth_throttles enable row level security;
revoke all on table internal.app_account_auth_throttles from public, anon, authenticated;

-- Immutable command receipts make idempotent status/access replays return the
-- result of the original command instead of unrelated later account state.
alter table internal.app_account_commands
  add column if not exists result_snapshot jsonb;

-- Password rotation v2 makes the client's observed credential version part of
-- the immutable command intent. Exact retries return the original snapshot,
-- plus a separately computed current-state flag so a superseded temporary
-- password is never presented as active.
create or replace function public.rotate_account_password_atomic_v2(
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
  current_credential_version bigint,
  currently_active boolean,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target internal.app_accounts%rowtype;
  actor internal.app_accounts%rowtype;
  current_credential internal.app_account_credentials%rowtype;
  prior internal.app_account_commands%rowtype;
  rotated record;
  command_digest text;
  immutable_result jsonb;
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
  select * into actor
  from internal.app_accounts a
  where a.account_id = p_actor_account_id
  for update;
  select * into target
  from internal.app_accounts a
  where a.account_id = p_account_id
  for update;
  if actor.account_id is null or target.account_id is null or actor.status <> 'active' then
    raise exception using errcode = '42501', message = 'account_password_forbidden';
  end if;
  if p_action = 'self_change' and actor.account_id <> target.account_id then
    raise exception using errcode = '42501', message = 'account_password_forbidden';
  end if;
  if p_action = 'admin_reset' and (
    not actor.super_admin or actor.account_id = target.account_id or target.super_admin
  ) then
    raise exception using errcode = '42501', message = 'account_password_reset_forbidden';
  end if;

  command_digest := encode(extensions.digest(jsonb_build_object(
    'accountId', p_account_id, 'passwordAlgorithm', p_password_algorithm,
    'passwordHash', p_password_hash, 'passwordSalt', p_password_salt,
    'expectedCredentialVersion', p_expected_credential_version,
    'mustChangePassword', p_must_change_password, 'action', p_action,
    'actorAccountId', p_actor_account_id
  )::text, 'sha256'), 'hex');
  select * into prior
  from internal.app_account_commands c
  where c.command_key = lower(p_command_key)
  for update;
  if prior.command_key is not null then
    if prior.command_hash <> command_digest or prior.action <> p_action
       or prior.account_id <> target.account_id
       or prior.actor_account_id <> actor.account_id then
      raise exception using errcode = '23505', message = 'account_command_idempotency_conflict';
    end if;
    if prior.result_snapshot is null
       or prior.result_snapshot - 'identityKey' - 'credentialVersion' - 'mustChangePassword' - 'enabled' <> '{}'::jsonb
       or jsonb_typeof(prior.result_snapshot -> 'identityKey') <> 'string'
       or jsonb_typeof(prior.result_snapshot -> 'credentialVersion') <> 'number'
       or jsonb_typeof(prior.result_snapshot -> 'mustChangePassword') <> 'boolean'
       or jsonb_typeof(prior.result_snapshot -> 'enabled') <> 'boolean' then
      raise exception using errcode = '55000', message = 'account_password_result_snapshot_missing';
    end if;
    select * into current_credential
    from internal.app_account_credentials c
    where c.account_id = target.account_id
    for update;
    return query select prior.command_key, false,
      prior.result_snapshot ->> 'identityKey',
      (prior.result_snapshot ->> 'credentialVersion')::bigint,
      (prior.result_snapshot ->> 'mustChangePassword')::boolean,
      (prior.result_snapshot ->> 'enabled')::boolean,
      current_credential.credential_version,
      target.status = 'active'
        and current_credential.enabled
        and current_credential.identity_key = (prior.result_snapshot ->> 'identityKey')
        and current_credential.credential_version = (prior.result_snapshot ->> 'credentialVersion')::bigint,
      prior.audit_id;
    return;
  end if;

  if target.status <> 'active' then
    raise exception using errcode = '55000', message = 'account_not_active';
  end if;
  select * into rotated from public.rotate_account_password_atomic(
    p_secret, p_command_key, p_account_id, p_password_algorithm,
    p_password_hash, p_password_salt, p_expected_credential_version,
    p_must_change_password, p_action, p_actor_account_id
  );
  if rotated.command_key is null or not rotated.applied then
    raise exception using errcode = '55000', message = 'account_password_rotation_result_invalid';
  end if;
  immutable_result := jsonb_build_object(
    'identityKey', rotated.identity_key,
    'credentialVersion', rotated.credential_version,
    'mustChangePassword', rotated.must_change_password,
    'enabled', rotated.enabled
  );
  update internal.app_account_commands c
  set result_snapshot = immutable_result
  where c.command_key = lower(p_command_key) and c.result_snapshot is null;
  if not found then
    raise exception using errcode = '55000', message = 'account_password_result_snapshot_write_failed';
  end if;
  return query select rotated.command_key, true, rotated.identity_key,
    rotated.credential_version, rotated.must_change_password, rotated.enabled,
    rotated.credential_version, target.status = 'active' and rotated.enabled,
    rotated.audit_entry_id;
end;
$$;

revoke all on function public.rotate_account_password_atomic(
  text, text, uuid, text, text, text, bigint, boolean, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function public.rotate_account_password_atomic_v2(
  text, text, uuid, text, text, text, bigint, boolean, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.rotate_account_password_atomic_v2(
  text, text, uuid, text, text, text, bigint, boolean, text, uuid
) to anon, authenticated;

-- Materialize current built-in staff and the server-owned teacher roster.
-- Later sign-ins continue to bridge newly-added roster members.
with known_accounts as (
  select staff_name as account_name, 'staff'::text as account_role
  from unnest(array['Abby', 'Ella', 'Molly', 'Thea', 'Tiffany', 'Tara', 'Eileen', '思佳']) staff_name
  union all
  select distinct trim(teacher.value ->> 'name'), 'teacher'::text
  from public.ops_state state
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(state.payload) = 'array' then state.payload else '[]'::jsonb end
  ) teacher(value)
  where state.entity = 'teachers'
    and jsonb_typeof(teacher.value) = 'object'
    and length(trim(teacher.value ->> 'name')) between 1 and 160
    and lower(trim(teacher.value ->> 'name')) not in ('nixon', 'ops admin')
)
insert into internal.app_accounts (
  identity_key, account_name, account_role, status, super_admin,
  created_by, updated_by
)
select internal.app_account_identity_key(account_name, account_role), account_name,
  account_role, 'active', false, 'account-lifecycle-hardening', 'account-lifecycle-hardening'
from known_accounts
on conflict (identity_key) do nothing;

create or replace function internal.app_account_default_permissions(p_account_role text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_account_role
    when 'admin' then array[
      'operations.read', 'operations.write'
    ]::text[]
    when 'limited-admin' then array[
      'operations.read', 'operations.write'
    ]::text[]
    when 'staff' then array[
      'operations.read', 'operations.write'
    ]::text[]
    when 'teacher' then array[
      'students.read.assigned', 'bookings.read.assigned', 'bookings.write.assigned',
      'messages.write.assigned', 'availability.write.self'
    ]::text[]
    else array[]::text[]
  end
$$;

-- Account-directory administration remains a super-admin capability. Remove
-- legacy-looking overrides that the application intentionally never honors.
delete from internal.app_account_permission_overrides
where permission in (
  'accounts.read', 'accounts.manage', 'accounts.sessions.revoke', 'accounts.mfa.reset', 'payroll.read'
);

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
    c.credential_version, coalesce(c.must_change_password, false), coalesce(m.enabled, false),
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
    c.credential_version, coalesce(c.must_change_password, false), coalesce(m.enabled, false),
    a.legacy_session_allowed, a.created_at, a.updated_at, a.updated_by
  from internal.app_accounts a
  left join internal.app_account_credentials c on c.account_id = a.account_id
  left join internal.app_account_mfa m on m.account_id = a.account_id
  order by lower(a.account_name), a.account_id;
end;
$$;

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
    credential.credential_version, coalesce(credential.must_change_password, false),
    coalesce((select m.enabled from internal.app_account_mfa m where m.account_id = saved.account_id), false),
    saved.legacy_session_allowed, saved.created_at, saved.updated_at, saved.updated_by;
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
  result_snapshot jsonb;
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
    return query select prior.account_id, p_status, prior.result_version,
      coalesce((prior.result_snapshot ->> 'revokedSessionCount')::integer, 0), prior.audit_id;
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
  -- Account status and credential status are independent. Disabling the
  -- account blocks authentication and revokes sessions without destroying
  -- whether an existing password was independently enabled; restore therefore
  -- neither revives a disabled credential nor strands a valid one.
  update internal.app_account_sessions s
  set revoked_at = now(), revoke_reason = case when p_status = 'disabled' then 'account_disabled' else 'account_restored' end
  where s.account_id = target.account_id and s.revoked_at is null;
  get diagnostics revoked_count = row_count;
  audit_id := internal.append_operational_contract_audit(
    case when p_status = 'disabled' then 'account.disabled' else 'account.restored' end,
    actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('status', target.status, 'accessVersion', target.access_version)
  );
  result_snapshot := jsonb_build_object(
    'accountId', target.account_id,
    'status', target.status,
    'accessVersion', target.access_version,
    'revokedSessionCount', revoked_count
  );
  insert into internal.app_account_commands(
    command_key, command_hash, action, account_id, actor_account_id, result_version, result_snapshot, audit_id
  ) values (
    lower(p_command_key), command_digest, 'status', target.account_id, actor.account_id,
    target.access_version, result_snapshot, audit_id
  );
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
  next_scope_version bigint;
  result_permissions text[];
  result_scope jsonb;
  result_snapshot jsonb;
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
  if target.super_admin then
    raise exception using errcode = '42501', message = 'super_admin_immutable';
  end if;
  if p_account_role <> target.account_role then
    raise exception using errcode = '22023', message = 'account_role_change_unsupported';
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
    if prior.result_snapshot is null or jsonb_typeof(prior.result_snapshot) <> 'object' then
      raise exception using errcode = '55000', message = 'account_command_replay_snapshot_unavailable';
    end if;
    return query select
      (prior.result_snapshot ->> 'accountId')::uuid,
      prior.result_snapshot ->> 'accountRole',
      prior.result_snapshot ->> 'status',
      (prior.result_snapshot ->> 'roleVersion')::bigint,
      (prior.result_snapshot ->> 'scopeVersion')::bigint,
      (prior.result_snapshot ->> 'accessVersion')::bigint,
      array(select jsonb_array_elements_text(prior.result_snapshot -> 'permissions')),
      prior.result_snapshot -> 'scopeMembers',
      prior.audit_id;
    return;
  end if;
  if target.role_version <> p_expected_role_version or target.scope_version <> p_expected_scope_version then
    raise exception using errcode = '40001', message = 'account_access_version_conflict';
  end if;
  next_scope_version := target.scope_version + 1;
  update internal.app_accounts a
  set scope_version = next_scope_version, access_version = a.access_version + 1,
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
  result_permissions := internal.app_account_effective_permissions(
    target.account_id, target.account_role, target.super_admin
  );
  result_scope := internal.app_account_effective_scope(
    target.account_id, target.account_role, target.super_admin
  );
  result_snapshot := jsonb_build_object(
    'accountId', target.account_id,
    'accountRole', target.account_role,
    'status', target.status,
    'roleVersion', target.role_version,
    'scopeVersion', target.scope_version,
    'accessVersion', target.access_version,
    'permissions', to_jsonb(result_permissions),
    'scopeMembers', result_scope
  );
  insert into internal.app_account_commands(
    command_key, command_hash, action, account_id, actor_account_id, result_version, result_snapshot, audit_id
  ) values (
    lower(p_command_key), command_digest, 'access', target.account_id, actor.account_id,
    target.access_version, result_snapshot, audit_id
  );
  return query select target.account_id, target.account_role, target.status, target.role_version,
    target.scope_version, target.access_version,
    result_permissions, result_scope, audit_id;
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
    credential.credential_version, coalesce(credential.must_change_password, false), saved.mfa_verified,
    internal.app_account_effective_permissions(target.account_id, target.account_role, target.super_admin),
    internal.app_account_effective_scope(target.account_id, target.account_role, target.super_admin);
end;
$$;

-- Logout uses the opaque v5 token as a narrow capability for its exact ledger
-- row. It intentionally bypasses downstream roster/role validation so a live
-- session cannot survive merely because that validation currently returns 401.
create or replace function public.revoke_current_account_session(
  p_secret text,
  p_session_id uuid,
  p_token_hash text
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
  saved internal.app_account_sessions%rowtype;
  target internal.app_accounts%rowtype;
  revoked_count integer := 0;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_session_id is null or coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_current_account_session_revoke';
  end if;
  select * into saved
  from internal.app_account_sessions s
  where s.session_id = p_session_id and s.token_hash = p_token_hash
  for update;
  if saved.session_id is null or saved.revoked_at is not null then
    return query select 0, null::uuid;
    return;
  end if;
  update internal.app_account_sessions s
  set revoked_at = now(), revoke_reason = 'explicit_logout'
  where s.session_id = saved.session_id and s.token_hash = p_token_hash
    and s.revoked_at is null;
  get diagnostics revoked_count = row_count;
  select * into target
  from internal.app_accounts a
  where a.account_id = saved.account_id;
  audit_id := internal.append_operational_contract_audit(
    'account.session_logged_out', coalesce(target.account_name, 'session-owner'),
    'account', saved.account_id::text,
    jsonb_build_object('revokedSessionCount', revoked_count)
  );
  return query select revoked_count, audit_id;
end;
$$;

revoke all on function public.revoke_current_account_session(text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_current_account_session(text, uuid, text)
  to anon, authenticated;

-- Every session established after password verification is bound to the exact
-- credential and access snapshot that was verified by the application.  The
-- earlier six-argument function remains only as the implementation primitive;
-- its direct Data API grant is removed below.
create or replace function public.create_account_session(
  p_secret text,
  p_session_id uuid,
  p_token_hash text,
  p_account_id uuid,
  p_expected_credential_version bigint,
  p_expected_access_version bigint,
  p_mfa_verified boolean,
  p_user_agent text
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
  credential internal.app_account_credentials%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_account_id is null or p_expected_credential_version is null
     or p_expected_credential_version < 0 or p_expected_access_version is null
     or p_expected_access_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_account_login_snapshot';
  end if;

  -- Password/status/access mutations lock the account before the credential.
  -- Use the same order so the snapshot remains stable until the session insert
  -- in the delegated implementation has committed.
  select * into target
  from internal.app_accounts a
  where a.account_id = p_account_id
  for update;
  select * into credential
  from internal.app_account_credentials c
  where c.account_id = p_account_id
  for update;

  if target.account_id is null or target.status <> 'active'
     or target.access_version <> p_expected_access_version
     or (p_expected_credential_version = 0 and credential.account_id is not null)
     or (p_expected_credential_version > 0 and (
       credential.account_id is null
       or not credential.enabled
       or credential.credential_version <> p_expected_credential_version
       or credential.identity_key is distinct from target.identity_key
       or credential.account_name is distinct from target.account_name
       or credential.account_role is distinct from target.account_role
     )) then
    raise exception using errcode = '40001', message = 'account_login_state_stale';
  end if;

  return query select * from public.create_account_session(
    p_secret, p_session_id, p_token_hash, p_account_id, p_mfa_verified, p_user_agent
  );
end;
$$;

-- MFA self-service mutations use an existing v5 server session as a second
-- concurrency token.  Holding account -> credential -> session locks prevents
-- a password reset or access mutation from crossing the verification/commit
-- boundary.
create or replace function internal.assert_account_security_session(
  p_secret text,
  p_account_id uuid,
  p_session_id uuid,
  p_expected_credential_version bigint,
  p_expected_access_version bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  checked_at timestamptz := clock_timestamp();
  target internal.app_accounts%rowtype;
  credential internal.app_account_credentials%rowtype;
  saved internal.app_account_sessions%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_account_id is null or p_session_id is null
     or p_expected_credential_version is null or p_expected_credential_version < 1
     or p_expected_access_version is null or p_expected_access_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_account_security_snapshot';
  end if;

  select * into target
  from internal.app_accounts a
  where a.account_id = p_account_id
  for update;
  select * into credential
  from internal.app_account_credentials c
  where c.account_id = p_account_id
  for update;
  select * into saved
  from internal.app_account_sessions s
  where s.session_id = p_session_id and s.account_id = p_account_id
  for update;

  if target.account_id is null or target.status <> 'active'
     or target.access_version <> p_expected_access_version
     or credential.account_id is null or not credential.enabled
     or credential.credential_version <> p_expected_credential_version
     or saved.session_id is null or saved.revoked_at is not null
     or saved.absolute_expires_at <= checked_at or saved.idle_expires_at <= checked_at
     or saved.access_version <> p_expected_access_version
     or saved.access_version <> target.access_version then
    raise exception using errcode = '40001', message = 'account_security_session_stale';
  end if;
end;
$$;

create or replace function public.begin_account_mfa_setup(
  p_secret text,
  p_account_id uuid,
  p_secret_ciphertext text,
  p_expected_mfa_version bigint,
  p_actor_account_id uuid,
  p_session_id uuid,
  p_expected_credential_version bigint,
  p_expected_access_version bigint
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
begin
  if p_actor_account_id is distinct from p_account_id then
    raise exception using errcode = '42501', message = 'account_mfa_forbidden';
  end if;
  perform internal.assert_account_security_session(
    p_secret, p_account_id, p_session_id,
    p_expected_credential_version, p_expected_access_version
  );
  return query select * from public.begin_account_mfa_setup(
    p_secret, p_account_id, p_secret_ciphertext, p_expected_mfa_version, p_actor_account_id
  );
end;
$$;

create or replace function public.confirm_account_mfa(
  p_secret text,
  p_account_id uuid,
  p_expected_mfa_version bigint,
  p_actor_account_id uuid,
  p_session_id uuid,
  p_expected_credential_version bigint,
  p_expected_access_version bigint
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
begin
  if p_actor_account_id is distinct from p_account_id then
    raise exception using errcode = '42501', message = 'account_mfa_forbidden';
  end if;
  perform internal.assert_account_security_session(
    p_secret, p_account_id, p_session_id,
    p_expected_credential_version, p_expected_access_version
  );
  return query select * from public.confirm_account_mfa(
    p_secret, p_account_id, p_expected_mfa_version, p_actor_account_id
  );
end;
$$;

create or replace function public.disable_account_mfa(
  p_secret text,
  p_account_id uuid,
  p_expected_mfa_version bigint,
  p_actor_account_id uuid,
  p_session_id uuid,
  p_expected_credential_version bigint,
  p_expected_access_version bigint
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
begin
  if p_actor_account_id is distinct from p_account_id then
    raise exception using errcode = '42501', message = 'account_mfa_forbidden';
  end if;
  perform internal.assert_account_security_session(
    p_secret, p_account_id, p_session_id,
    p_expected_credential_version, p_expected_access_version
  );
  return query select * from public.disable_account_mfa(
    p_secret, p_account_id, p_expected_mfa_version, p_actor_account_id
  );
end;
$$;

revoke all on function internal.assert_account_security_session(text, uuid, uuid, bigint, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.create_account_session(text, uuid, text, uuid, boolean, text)
  from public, anon, authenticated, service_role;
revoke all on function public.begin_account_mfa_setup(text, uuid, text, bigint, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_account_mfa(text, uuid, bigint, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.disable_account_mfa(text, uuid, bigint, uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.create_account_session(text, uuid, text, uuid, bigint, bigint, boolean, text)
  from public, anon, authenticated, service_role;
revoke all on function public.begin_account_mfa_setup(text, uuid, text, bigint, uuid, uuid, bigint, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_account_mfa(text, uuid, bigint, uuid, uuid, bigint, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.disable_account_mfa(text, uuid, bigint, uuid, uuid, bigint, bigint)
  from public, anon, authenticated, service_role;

grant execute on function public.create_account_session(text, uuid, text, uuid, bigint, bigint, boolean, text)
  to anon, authenticated;
grant execute on function public.begin_account_mfa_setup(text, uuid, text, bigint, uuid, uuid, bigint, bigint)
  to anon, authenticated;
grant execute on function public.confirm_account_mfa(text, uuid, bigint, uuid, uuid, bigint, bigint)
  to anon, authenticated;
grant execute on function public.disable_account_mfa(text, uuid, bigint, uuid, uuid, bigint, bigint)
  to anon, authenticated;

-- Admission and attempt consumption happen in one row-locked transaction.
-- The request that reaches a threshold is admitted, installs the block, and
-- every later concurrent request observes that block before verification.
create or replace function public.admit_account_auth_attempt(
  p_secret text,
  p_throttle_keys text[]
)
returns table (
  blocked boolean,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  admitted_at timestamptz := clock_timestamp();
  throttle_key_value text;
  throttle internal.app_account_auth_throttles%rowtype;
  next_attempts integer;
  next_window timestamptz;
  candidate_block timestamptz;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_throttle_keys is null or cardinality(p_throttle_keys) not between 1 and 2
     or exists (
       select 1 from unnest(p_throttle_keys) key
       where key is null or key !~ '^[ni]:[a-f0-9]{64}$'
     )
     or (select count(*) from unnest(p_throttle_keys) key where key like 'n:%') <> 1
     or (select count(*) from unnest(p_throttle_keys) key where key like 'i:%') > 1 then
    raise exception using errcode = '22023', message = 'invalid_auth_throttle_admission';
  end if;

  delete from internal.app_account_auth_throttles t where t.throttle_key in (
    select stale.throttle_key
    from internal.app_account_auth_throttles stale
    where stale.updated_at < admitted_at - interval '7 days'
      and coalesce(stale.blocked_until, '-infinity'::timestamptz) < admitted_at
    order by stale.updated_at
    limit 100
  );

  -- Lock and inspect every supplied dimension before incrementing any of
  -- them. The network row remains first, so a blocked network still returns
  -- before an attacker-controlled identity key can be materialized. If only
  -- the identity is blocked, the already-locked network row is left unchanged.
  for throttle_key_value in
    select key from unnest(p_throttle_keys) key
    order by case when key like 'n:%' then 0 else 1 end, key
  loop
    insert into internal.app_account_auth_throttles(throttle_key, failed_attempts, window_started_at, updated_at)
    values (throttle_key_value, 0, admitted_at, admitted_at)
    on conflict (throttle_key) do nothing;

    select * into throttle
    from internal.app_account_auth_throttles t
    where t.throttle_key = throttle_key_value
    for update;

    if throttle.blocked_until > admitted_at then
      return query select true,
        greatest(1, ceil(extract(epoch from throttle.blocked_until - admitted_at))::integer);
      return;
    end if;
  end loop;

  for throttle_key_value in
    select key from unnest(p_throttle_keys) key
    order by case when key like 'n:%' then 0 else 1 end, key
  loop
    select * into throttle
    from internal.app_account_auth_throttles t
    where t.throttle_key = throttle_key_value
    for update;
    if throttle.window_started_at < admitted_at - interval '15 minutes' then
      next_attempts := 1;
      next_window := admitted_at;
    else
      next_attempts := throttle.failed_attempts + 1;
      next_window := throttle.window_started_at;
    end if;

    candidate_block := case
      when throttle_key_value like 'n:%' and next_attempts >= 500 then admitted_at + interval '5 minutes'
      when throttle_key_value like 'n:%' and next_attempts >= 250 then admitted_at + interval '2 minutes'
      when throttle_key_value like 'n:%' and next_attempts >= 100 then admitted_at + interval '30 seconds'
      when throttle_key_value like 'i:%' and next_attempts >= 10 then admitted_at + interval '1 hour'
      when throttle_key_value like 'i:%' and next_attempts >= 7 then admitted_at + interval '15 minutes'
      when throttle_key_value like 'i:%' and next_attempts >= 5 then admitted_at + interval '2 minutes'
      else null
    end;

    update internal.app_account_auth_throttles t
    set failed_attempts = next_attempts,
        window_started_at = next_window,
        blocked_until = candidate_block,
        updated_at = admitted_at
    where t.throttle_key = throttle_key_value;
  end loop;

  return query select false, 0;
end;
$$;

create or replace function public.check_account_auth_throttle(
  p_secret text,
  p_throttle_keys text[]
)
returns table (
  blocked boolean,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  checked_at timestamptz := clock_timestamp();
  latest_block timestamptz;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_throttle_keys is null or cardinality(p_throttle_keys) not between 1 and 4
     or exists (
       select 1 from unnest(p_throttle_keys) key
       where key is null or key !~ '^[ni]:[a-f0-9]{64}$'
     ) then
    raise exception using errcode = '22023', message = 'invalid_auth_throttle_keys';
  end if;

  delete from internal.app_account_auth_throttles t
  where t.updated_at < checked_at - interval '7 days'
    and coalesce(t.blocked_until, '-infinity'::timestamptz) < checked_at;

  select max(t.blocked_until) into latest_block
  from internal.app_account_auth_throttles t
  where t.throttle_key = any(p_throttle_keys)
    and t.blocked_until > checked_at;

  return query select latest_block is not null,
    case when latest_block is null then 0
      else greatest(1, ceil(extract(epoch from latest_block - checked_at))::integer)
    end;
end;
$$;

create or replace function public.record_account_auth_attempt(
  p_secret text,
  p_throttle_keys text[],
  p_succeeded boolean
)
returns table (
  blocked boolean,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  recorded_at timestamptz := clock_timestamp();
  throttle_key_value text;
  throttle internal.app_account_auth_throttles%rowtype;
  next_attempts integer;
  next_window timestamptz;
  candidate_block timestamptz;
  latest_block timestamptz;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_succeeded is null or p_throttle_keys is null or cardinality(p_throttle_keys) not between 1 and 4
     or exists (
       select 1 from unnest(p_throttle_keys) key
       where key is null or key !~ '^[ni]:[a-f0-9]{64}$'
     ) then
    raise exception using errcode = '22023', message = 'invalid_auth_throttle_attempt';
  end if;

  if p_succeeded then
    if cardinality(p_throttle_keys) not between 1 and 2
       or (select count(*) from unnest(p_throttle_keys) key where key like 'n:%') <> 1
       or (select count(*) from unnest(p_throttle_keys) key where key like 'i:%') > 1 then
      raise exception using errcode = '22023', message = 'invalid_auth_throttle_settlement';
    end if;
    -- Admission increments before verification so concurrent requests cannot
    -- overrun a threshold. A success reverses only its own increment; it must
    -- never delete failures belonging to another request on the same network
    -- or identity. Locks follow the same network-first order as admission.
    for throttle_key_value in
      select distinct key from unnest(p_throttle_keys) key
      order by case when key like 'n:%' then 0 else 1 end, key
    loop
      select * into throttle
      from internal.app_account_auth_throttles t
      where t.throttle_key = throttle_key_value
      for update;
      if throttle.throttle_key is null then continue; end if;
      if throttle.window_started_at < recorded_at - interval '15 minutes' then
        delete from internal.app_account_auth_throttles t
        where t.throttle_key = throttle_key_value;
        continue;
      end if;

      next_attempts := greatest(0, throttle.failed_attempts - 1);
      if next_attempts = 0 then
        delete from internal.app_account_auth_throttles t
        where t.throttle_key = throttle_key_value;
        continue;
      end if;
      candidate_block := case
        when throttle_key_value like 'n:%' and next_attempts >= 500 then recorded_at + interval '5 minutes'
        when throttle_key_value like 'n:%' and next_attempts >= 250 then recorded_at + interval '2 minutes'
        when throttle_key_value like 'n:%' and next_attempts >= 100 then recorded_at + interval '30 seconds'
        when throttle_key_value like 'i:%' and next_attempts >= 10 then recorded_at + interval '1 hour'
        when throttle_key_value like 'i:%' and next_attempts >= 7 then recorded_at + interval '15 minutes'
        when throttle_key_value like 'i:%' and next_attempts >= 5 then recorded_at + interval '2 minutes'
        else null
      end;
      update internal.app_account_auth_throttles t
      set failed_attempts = next_attempts,
          blocked_until = candidate_block,
          updated_at = recorded_at
      where t.throttle_key = throttle_key_value;
    end loop;
    return query select false, 0;
    return;
  end if;

  for throttle_key_value in
    select distinct key from unnest(p_throttle_keys) key
    order by case when key like 'n:%' then 0 else 1 end, key
  loop
    insert into internal.app_account_auth_throttles(throttle_key, failed_attempts, window_started_at, updated_at)
    values (throttle_key_value, 0, recorded_at, recorded_at)
    on conflict (throttle_key) do nothing;

    select * into throttle
    from internal.app_account_auth_throttles t
    where t.throttle_key = throttle_key_value
    for update;

    if throttle.window_started_at < recorded_at - interval '15 minutes' then
      next_attempts := 1;
      next_window := recorded_at;
    else
      next_attempts := throttle.failed_attempts + 1;
      next_window := throttle.window_started_at;
    end if;

    candidate_block := case
      when throttle_key_value like 'n:%' and next_attempts >= 500 then recorded_at + interval '5 minutes'
      when throttle_key_value like 'n:%' and next_attempts >= 250 then recorded_at + interval '2 minutes'
      when throttle_key_value like 'n:%' and next_attempts >= 100 then recorded_at + interval '30 seconds'
      when throttle_key_value like 'i:%' and next_attempts >= 10 then recorded_at + interval '1 hour'
      when throttle_key_value like 'i:%' and next_attempts >= 7 then recorded_at + interval '15 minutes'
      when throttle_key_value like 'i:%' and next_attempts >= 5 then recorded_at + interval '2 minutes'
      else null
    end;

    update internal.app_account_auth_throttles t
    set failed_attempts = next_attempts,
        window_started_at = next_window,
        blocked_until = case
          when candidate_block is null then throttle.blocked_until
          else greatest(coalesce(throttle.blocked_until, candidate_block), candidate_block)
        end,
        updated_at = recorded_at
    where t.throttle_key = throttle_key_value;
  end loop;

  select max(t.blocked_until) into latest_block
  from internal.app_account_auth_throttles t
  where t.throttle_key = any(p_throttle_keys)
    and t.blocked_until > recorded_at;

  return query select latest_block is not null,
    case when latest_block is null then 0
      else greatest(1, ceil(extract(epoch from latest_block - recorded_at))::integer)
    end;
end;
$$;

revoke all on function public.admit_account_auth_attempt(text, text[]) from public, anon, authenticated;
revoke all on function public.check_account_auth_throttle(text, text[]) from public, anon, authenticated;
revoke all on function public.record_account_auth_attempt(text, text[], boolean) from public, anon, authenticated;
grant execute on function public.admit_account_auth_attempt(text, text[]) to anon, authenticated;
grant execute on function public.check_account_auth_throttle(text, text[]) to anon, authenticated;
grant execute on function public.record_account_auth_attempt(text, text[], boolean) to anon, authenticated;

-- Lost-response retries must be able to recover their actor-bound immutable
-- receipt before current task, planner, or lifecycle authority is consulted.
-- This reader deliberately returns no student, booking, or operational rows.
create or replace function public.get_trial_payment_completion_command_result(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_task_id text,
  p_actor text
)
returns table (
  command_key text,
  task_id text,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior internal.trial_payment_completion_commands%rowtype;
  command_hash text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^trial-payment-complete:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or p_command_intent is distinct from jsonb_build_object('action', 'complete', 'taskId', p_task_id)
     or nullif(trim(p_task_id), '') is null
     or nullif(trim(p_actor), '') is null then
    raise exception using errcode = '22023', message = 'invalid_trial_payment_completion_receipt_query';
  end if;
  command_hash := encode(extensions.digest(jsonb_build_object(
    'intent', p_command_intent, 'actor', trim(p_actor)
  )::text, 'sha256'), 'hex');
  select * into prior
  from internal.trial_payment_completion_commands commands
  where commands.command_key = p_command_key;
  if prior.command_key is null then return; end if;
  if prior.command_sha256 is distinct from command_hash
     or prior.command_intent is distinct from p_command_intent
     or prior.task_id is distinct from p_task_id
     or prior.actor is distinct from trim(p_actor) then
    raise exception using errcode = '23505', message = 'trial_payment_completion_idempotency_conflict';
  end if;
  return query select prior.command_key, prior.task_id, prior.audit_id;
end;
$$;

revoke all on function public.get_trial_payment_completion_command_result(text, text, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_trial_payment_completion_command_result(text, text, jsonb, text, text)
  to anon, authenticated;

-- Preserve super-admin task completion while keeping staff planner-bound.
-- This forward replacement leaves the already-applied source migration immutable.
create or replace function public.complete_trial_payment_task_atomic(
  p_secret text,
  p_command_key text,
  p_command_intent jsonb,
  p_task_id text,
  p_expected_versions jsonb,
  p_actor text,
  p_actor_role text
)
returns table (
  command_key text,
  applied boolean,
  task_id text,
  booking_id text,
  student_id text,
  bookings_row public.ops_state,
  students_row public.ops_state,
  lp_items_row public.ops_state,
  tasks_row public.ops_state,
  teachers_row public.ops_state,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  b public.ops_state%rowtype;
  s public.ops_state%rowtype;
  l public.ops_state%rowtype;
  t public.ops_state%rowtype;
  h public.ops_state%rowtype;
  saved_t public.ops_state%rowtype;
  prior internal.trial_payment_completion_commands%rowtype;
  task_item jsonb;
  booking_item jsonb;
  student_item jsonb;
  lp_item jsonb;
  next_tasks jsonb;
  booking_id_value text;
  student_id_value text;
  method text;
  completed_at timestamptz;
  command_hash text;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^trial-payment-complete:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command_intent) is distinct from 'object'
     or p_command_intent is distinct from jsonb_build_object('action', 'complete', 'taskId', p_task_id)
     or nullif(trim(p_task_id), '') is null
     or nullif(trim(p_actor), '') is null
     or p_actor_role not in ('admin', 'limited-admin', 'staff', 'teacher')
     or jsonb_typeof(p_expected_versions) is distinct from 'object'
     or p_expected_versions - 'bookings' - 'students' - 'lpItems' - 'tasks' - 'teachers' <> '{}'::jsonb
     or jsonb_typeof(p_expected_versions -> 'bookings') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'students') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'lpItems') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'tasks') is distinct from 'number'
     or jsonb_typeof(p_expected_versions -> 'teachers') is distinct from 'number' then
    raise exception using errcode = '22023', message = 'invalid_trial_payment_completion_command';
  end if;
  command_hash := encode(extensions.digest(jsonb_build_object(
    'intent', p_command_intent, 'actor', trim(p_actor)
  )::text, 'sha256'), 'hex');

  -- Receipt lookup intentionally precedes current task/scope reads. A command
  -- that committed before a lost response remains confirmable by the exact
  -- actor+intent even if planner, task or LP authority changed afterwards.
  select * into prior from internal.trial_payment_completion_commands commands
  where commands.command_key = p_command_key;
  if prior.command_key is not null and (
       prior.command_sha256 is distinct from command_hash
       or prior.command_intent is distinct from p_command_intent
       or prior.task_id is distinct from p_task_id
       or prior.actor is distinct from trim(p_actor)
     ) then
    raise exception using errcode = '23505', message = 'trial_payment_completion_idempotency_conflict';
  end if;

  -- Same global lock order as booking mutation and scheduler reconciliation.
  select * into b from public.ops_state where entity = 'bookings' for update;
  select * into s from public.ops_state where entity = 'students' for update;
  select * into l from public.ops_state where entity = 'lpItems' for update;
  select * into t from public.ops_state where entity = 'tasks' for update;
  select * into h from public.ops_state where entity = 'teachers' for update;
  if b.entity is null or s.entity is null or l.entity is null or t.entity is null or h.entity is null then
    raise exception using errcode = '55000', message = 'trial_payment_state_missing';
  end if;
  if prior.command_key is not null then
    return query select p_command_key, false, p_task_id, prior.booking_id,
      prior.student_id, b, s, l, t, h, prior.audit_id;
    return;
  end if;

  -- A concurrent first submit can commit while this transaction waits on the
  -- fixed row locks. Recheck the ledger before any current authority/OCC test.
  select * into prior from internal.trial_payment_completion_commands commands
  where commands.command_key = p_command_key;
  if prior.command_key is not null then
    if prior.command_sha256 is distinct from command_hash
       or prior.command_intent is distinct from p_command_intent
       or prior.task_id is distinct from p_task_id
       or prior.actor is distinct from trim(p_actor) then
      raise exception using errcode = '23505', message = 'trial_payment_completion_idempotency_conflict';
    end if;
    return query select p_command_key, false, p_task_id, prior.booking_id,
      prior.student_id, b, s, l, t, h, prior.audit_id;
    return;
  end if;
  if jsonb_typeof(b.payload) is distinct from 'array'
     or jsonb_typeof(s.payload) is distinct from 'array'
     or jsonb_typeof(l.payload) is distinct from 'array'
     or jsonb_typeof(t.payload) is distinct from 'array'
     or jsonb_typeof(h.payload) is distinct from 'array' then
    raise exception using errcode = '55000', message = 'trial_payment_state_invalid';
  end if;
  -- Current signed role gates only a first write. The immutable super-admin
  -- may complete any currently visible reminder; staff remain planner-bound.
  -- An exact actor+intent replay has already returned above, so later role drift
  -- cannot strand its receipt.
  if p_actor_role not in ('staff', 'admin') then
    raise exception using errcode = '42501', message = 'trial_payment_role_forbidden';
  end if;
  if (select count(*) from jsonb_array_elements(t.payload) item(value)
      where item.value ->> 'id' = p_task_id) <> 1 then
    raise exception using errcode = 'P0002', message = 'trial_payment_task_not_found';
  end if;
  select item.value into task_item from jsonb_array_elements(t.payload) item(value)
  where item.value ->> 'id' = p_task_id;
  booking_id_value := task_item ->> 'anchorBookingId';
  student_id_value := task_item ->> 'studentId';
  if task_item ->> 'ruleKey' not in ('trial.payment-n2', 'trial.payment-urgent')
     or task_item ->> 'category' <> '试听'
     or (p_actor_role <> 'admin' and (
       task_item ->> 'owner' is distinct from trim(p_actor)
       or task_item -> 'assignees' is distinct from jsonb_build_array(trim(p_actor))
     ))
     or task_item -> 'watchers' is distinct from jsonb_build_array('Ops Admin') then
    raise exception using errcode = '42501', message = 'trial_payment_task_forbidden';
  end if;
  if (select count(*) from jsonb_array_elements(b.payload) item(value)
      where item.value ->> 'id' = booking_id_value
        and item.value ->> 'studentId' = student_id_value
        and item.value ->> 'kind' = '试听') <> 1 then
    raise exception using errcode = '42501', message = 'trial_payment_booking_forbidden';
  end if;
  select item.value into booking_item from jsonb_array_elements(b.payload) item(value)
  where item.value ->> 'id' = booking_id_value;
  if (select count(*) from jsonb_array_elements(s.payload) item(value)
      where item.value ->> 'id' = student_id_value and item.value ->> 'importArchived' is distinct from 'true') <> 1 then
    raise exception using errcode = '42501', message = 'trial_payment_student_forbidden';
  end if;
  select item.value into student_item from jsonb_array_elements(s.payload) item(value)
  where item.value ->> 'id' = student_id_value;
  if p_actor_role <> 'admin'
     and nullif(trim(student_item ->> 'planner'), '') is distinct from trim(p_actor) then
    raise exception using errcode = '42501', message = 'trial_payment_planner_forbidden';
  end if;
  lp_item := internal.trial_payment_lp_for_student(
    l.payload, t.payload, student_id_value, booking_id_value
  );
  method := nullif(trim(lp_item -> 'fields' ->> 'trialPaymentMethod'), '');
  if (method in ('后置付费试听', '付费试听（已付费）', '付费试听（未付费）', '在读学生付费试听')) is not true then
    raise exception using errcode = '42501', message = 'trial_payment_method_forbidden';
  end if;

  if b.version <> (p_expected_versions ->> 'bookings')::bigint
     or s.version <> (p_expected_versions ->> 'students')::bigint
     or l.version <> (p_expected_versions ->> 'lpItems')::bigint
     or t.version <> (p_expected_versions ->> 'tasks')::bigint
     or h.version <> (p_expected_versions ->> 'teachers')::bigint then
    raise exception using errcode = '40001', message = 'version_conflict';
  end if;
  if task_item ->> 'status' = 'done' then
    raise exception using errcode = '22023', message = 'trial_payment_task_already_completed';
  end if;
  completed_at := clock_timestamp();
  select coalesce(jsonb_agg(
    case when item.value ->> 'id' = p_task_id
                  and item.value ->> 'anchorBookingId' = booking_id_value
                  and item.value ->> 'studentId' = student_id_value
                  and item.value ->> 'ruleKey' in ('trial.payment-n2', 'trial.payment-urgent')
                  and (p_actor_role = 'admin' or (
                    item.value ->> 'owner' = trim(p_actor)
                    and item.value -> 'assignees' = jsonb_build_array(trim(p_actor))
                  ))
                  and item.value -> 'watchers' = jsonb_build_array('Ops Admin')
      then item.value || jsonb_build_object(
        'status', 'done', 'tone', 'green',
        'result', case when p_actor_role = 'admin' then '已由管理员确认试听付款' else '已由规划老师确认试听付款' end,
        'closedAt', internal.trial_payment_iso(completed_at)
      ) else item.value end order by item.ordinality
  ), '[]'::jsonb) into next_tasks
  from jsonb_array_elements(t.payload) with ordinality item(value, ordinality);
  update public.ops_state set payload = next_tasks, version = t.version + 1,
    updated_at = now(), updated_by = left(trim(p_actor), 120)
  where entity = 'tasks' returning * into saved_t;
  insert into public.ops_mutation_log(entity, version, actor)
  values ('tasks', saved_t.version, saved_t.updated_by);
  audit_id := internal.append_operational_contract_audit(
    'trial_payment_complete', trim(p_actor), 'task', p_task_id,
    jsonb_build_object('bookingId', booking_id_value, 'studentId', student_id_value)
  );
  insert into internal.trial_payment_completion_commands(
    command_key, command_intent, command_sha256, task_id, booking_id,
    student_id, task_version, actor, applied_at, audit_id
  ) values (
    p_command_key, p_command_intent, command_hash, p_task_id, booking_id_value,
    student_id_value, saved_t.version, left(trim(p_actor), 120), completed_at, audit_id
  );
  return query select p_command_key, true, p_task_id, booking_id_value,
    student_id_value, b, s, l, saved_t, h, audit_id;
end;
$function$;

revoke all on function public.complete_trial_payment_task_atomic(text, text, jsonb, text, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_trial_payment_task_atomic(text, text, jsonb, text, jsonb, text, text)
  to anon, authenticated;

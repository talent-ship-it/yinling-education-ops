-- Incremental credentials for the existing role/account directory.  Legacy
-- review logins remain available until an account sets or receives its first
-- independent password; no legacy password or plaintext credential is copied.

create table if not exists internal.app_account_credentials (
  identity_key text primary key check (identity_key ~ '^[a-f0-9]{64}$'),
  account_name text not null check (length(account_name) between 1 and 160),
  account_role text not null check (account_role in ('admin', 'limited-admin', 'staff', 'teacher')),
  password_algorithm text not null check (password_algorithm = 'scrypt-v1'),
  password_hash text not null check (password_hash ~ '^[a-f0-9]{128}$'),
  password_salt text not null check (password_salt ~ '^[a-f0-9]{32}$'),
  credential_version bigint not null check (credential_version > 0),
  must_change_password boolean not null default false,
  enabled boolean not null default true,
  password_changed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null check (length(updated_by) between 1 and 160),
  unique (account_name, account_role)
);

alter table internal.app_account_credentials enable row level security;
revoke all on table internal.app_account_credentials from public, anon, authenticated;

create table if not exists internal.app_account_credential_commands (
  command_key text primary key check (
    command_key ~ '^account-credential:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  command_hash text not null check (command_hash ~ '^[a-f0-9]{64}$'),
  identity_key text not null check (identity_key ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('self_change', 'admin_reset')),
  credential_version bigint not null check (credential_version > 0),
  actor text not null check (length(actor) between 1 and 160),
  audit_id uuid not null references internal.operational_contract_audit(id),
  created_at timestamptz not null default now()
);

alter table internal.app_account_credential_commands enable row level security;
revoke all on table internal.app_account_credential_commands from public, anon, authenticated;

create or replace function public.read_app_account_auth_state(
  p_secret text,
  p_identity_key text
)
returns table (
  identity_key text,
  account_name text,
  account_role text,
  credential_version bigint,
  must_change_password boolean,
  enabled boolean
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
    select c.identity_key, c.account_name, c.account_role, c.credential_version,
      c.must_change_password, c.enabled
    from internal.app_account_credentials c
    where c.identity_key = p_identity_key;
end;
$$;

create or replace function public.read_app_account_credential(
  p_secret text,
  p_identity_key text
)
returns table (
  identity_key text,
  account_name text,
  account_role text,
  password_algorithm text,
  password_hash text,
  password_salt text,
  credential_version bigint,
  must_change_password boolean,
  enabled boolean
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
    select c.identity_key, c.account_name, c.account_role, c.password_algorithm,
      c.password_hash, c.password_salt, c.credential_version,
      c.must_change_password, c.enabled
    from internal.app_account_credentials c
    where c.identity_key = p_identity_key;
end;
$$;

create or replace function public.put_app_account_credential_atomic(
  p_secret text,
  p_command_key text,
  p_identity_key text,
  p_account_name text,
  p_account_role text,
  p_password_algorithm text,
  p_password_hash text,
  p_password_salt text,
  p_expected_version bigint,
  p_must_change_password boolean,
  p_action text,
  p_actor text
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
  prior internal.app_account_credential_commands%rowtype;
  current_credential internal.app_account_credentials%rowtype;
  saved_credential internal.app_account_credentials%rowtype;
  canonical_name text;
  canonical_actor text;
  command_digest text;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^account-credential:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or coalesce(p_identity_key, '') !~ '^[a-f0-9]{64}$'
     or nullif(trim(p_account_name), '') is null or length(trim(p_account_name)) > 160
     or p_account_role not in ('admin', 'limited-admin', 'staff', 'teacher')
     or p_password_algorithm <> 'scrypt-v1'
     or coalesce(p_password_hash, '') !~ '^[a-f0-9]{128}$'
     or coalesce(p_password_salt, '') !~ '^[a-f0-9]{32}$'
     or p_expected_version is null or p_expected_version < 0
     or p_must_change_password is null
     or p_action not in ('self_change', 'admin_reset')
     or nullif(trim(p_actor), '') is null or length(trim(p_actor)) > 160 then
    raise exception using errcode = '22023', message = 'invalid_account_credential_command';
  end if;

  canonical_name := trim(p_account_name);
  canonical_actor := trim(p_actor);
  command_digest := encode(extensions.digest(
    jsonb_build_object(
      'identityKey', p_identity_key,
      'accountName', canonical_name,
      'accountRole', p_account_role,
      'passwordAlgorithm', p_password_algorithm,
      'passwordHash', p_password_hash,
      'passwordSalt', p_password_salt,
      'expectedVersion', p_expected_version,
      'mustChangePassword', p_must_change_password,
      'action', p_action,
      'actor', canonical_actor
    )::text,
    'sha256'
  ), 'hex');

  lock table internal.app_account_credential_commands in share row exclusive mode;
  select * into prior
  from internal.app_account_credential_commands c
  where c.command_key = lower(p_command_key);
  if prior.command_key is not null then
    if prior.command_hash <> command_digest
       or prior.identity_key <> p_identity_key
       or prior.action <> p_action
       or prior.actor <> canonical_actor then
      raise exception using errcode = '23505', message = 'account_credential_idempotency_conflict';
    end if;
    select * into saved_credential
    from internal.app_account_credentials c
    where c.identity_key = prior.identity_key;
    if saved_credential.identity_key is null
       or saved_credential.credential_version <> prior.credential_version then
      raise exception using errcode = '55000', message = 'account_credential_replay_superseded';
    end if;
    return query select prior.command_key, false, saved_credential.identity_key,
      saved_credential.credential_version, saved_credential.must_change_password,
      saved_credential.enabled, prior.audit_id;
    return;
  end if;

  select * into current_credential
  from internal.app_account_credentials c
  where c.identity_key = p_identity_key
  for update;

  if current_credential.identity_key is null then
    if p_expected_version <> 0 then
      raise exception using errcode = '40001', message = 'account_credential_version_conflict';
    end if;
    insert into internal.app_account_credentials (
      identity_key, account_name, account_role, password_algorithm,
      password_hash, password_salt, credential_version,
      must_change_password, enabled, updated_by
    ) values (
      p_identity_key, canonical_name, p_account_role, p_password_algorithm,
      p_password_hash, p_password_salt, 1,
      p_must_change_password, true, canonical_actor
    ) returning * into saved_credential;
  else
    if current_credential.account_name <> canonical_name
       or current_credential.account_role <> p_account_role then
      raise exception using errcode = '23505', message = 'account_credential_identity_conflict';
    end if;
    if current_credential.credential_version <> p_expected_version then
      raise exception using errcode = '40001', message = 'account_credential_version_conflict';
    end if;
    update internal.app_account_credentials c
    set password_algorithm = p_password_algorithm,
      password_hash = p_password_hash,
      password_salt = p_password_salt,
      credential_version = c.credential_version + 1,
      must_change_password = p_must_change_password,
      enabled = true,
      password_changed_at = now(),
      updated_at = now(),
      updated_by = canonical_actor
    where c.identity_key = p_identity_key
    returning * into saved_credential;
  end if;

  audit_id := internal.append_operational_contract_audit(
    case when p_action = 'admin_reset' then 'account.password_reset' else 'account.password_changed' end,
    canonical_actor,
    'account',
    p_identity_key,
    jsonb_build_object(
      'accountRole', p_account_role,
      'credentialVersion', saved_credential.credential_version,
      'mustChangePassword', saved_credential.must_change_password
    )
  );
  insert into internal.app_account_credential_commands (
    command_key, command_hash, identity_key, action,
    credential_version, actor, audit_id
  ) values (
    lower(p_command_key), command_digest, p_identity_key, p_action,
    saved_credential.credential_version, canonical_actor, audit_id
  );

  return query select lower(p_command_key), true, saved_credential.identity_key,
    saved_credential.credential_version, saved_credential.must_change_password,
    saved_credential.enabled, audit_id;
end;
$$;

revoke all on function public.read_app_account_auth_state(text, text)
  from public, anon, authenticated;
revoke all on function public.read_app_account_credential(text, text)
  from public, anon, authenticated;
revoke all on function public.put_app_account_credential_atomic(
  text, text, text, text, text, text, text, text, bigint, boolean, text, text
) from public, anon, authenticated;

grant execute on function public.read_app_account_auth_state(text, text)
  to anon, authenticated;
grant execute on function public.read_app_account_credential(text, text)
  to anon, authenticated;
grant execute on function public.put_app_account_credential_atomic(
  text, text, text, text, text, text, text, text, bigint, boolean, text, text
) to anon, authenticated;

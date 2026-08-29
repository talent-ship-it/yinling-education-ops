-- PostgreSQL ARE repetition bounds are limited to 255. Validate the envelope
-- length separately so legitimate AES-GCM payloads do not raise SQLSTATE 2201B.

alter table internal.app_account_issued_passwords
  drop constraint if exists app_account_issued_passwords_check;
alter table internal.app_account_issued_passwords
  add constraint app_account_issued_passwords_check check (
    (
      state = 'available'
      and ciphertext is not null
      and char_length(ciphertext) <= 920
      and ciphertext ~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22,}$'
    )
    or (state = 'self_changed' and ciphertext is null)
  );

create or replace function public.rotate_account_password_tx_v3(
  p_secret text,
  p_command_key text,
  p_account_id uuid,
  p_password_algorithm text,
  p_password_hash text,
  p_password_salt text,
  p_expected_credential_version bigint,
  p_must_change_password boolean,
  p_action text,
  p_actor_account_id uuid,
  p_issued_password_ciphertext text
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
  rotated record;
  saved internal.app_account_issued_passwords%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_action = 'admin_reset' and (
       p_must_change_password
       or char_length(coalesce(p_issued_password_ciphertext, '')) > 920
       or coalesce(p_issued_password_ciphertext, '') !~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22,}$'
     ) then
    raise exception using errcode = '22023', message = 'invalid_admin_issued_password_escrow';
  end if;
  if p_action = 'self_change' and p_issued_password_ciphertext is not null then
    raise exception using errcode = '22023', message = 'self_password_must_not_be_escrowed';
  end if;

  select * into rotated from public.rotate_account_password_tx_v2(
    p_secret, p_command_key, p_account_id, p_password_algorithm,
    p_password_hash, p_password_salt, p_expected_credential_version,
    p_must_change_password, p_action, p_actor_account_id
  );
  if rotated.command_key is null then
    raise exception using errcode = '55000', message = 'account_password_rotation_result_invalid';
  end if;

  if rotated.currently_active then
    if p_action = 'admin_reset' then
      insert into internal.app_account_issued_passwords (
        account_id, identity_key, credential_version, state, ciphertext,
        issued_by_account_id, issued_at, cleared_at, source_command_key,
        last_audit_id, updated_at
      ) values (
        p_account_id, rotated.identity_key, rotated.credential_version,
        'available', p_issued_password_ciphertext, p_actor_account_id, now(),
        null, lower(p_command_key), rotated.audit_entry_id, now()
      )
      on conflict (account_id) do update
      set identity_key = excluded.identity_key,
          credential_version = excluded.credential_version,
          state = excluded.state,
          ciphertext = excluded.ciphertext,
          issued_by_account_id = excluded.issued_by_account_id,
          issued_at = excluded.issued_at,
          cleared_at = null,
          source_command_key = excluded.source_command_key,
          last_audit_id = excluded.last_audit_id,
          updated_at = excluded.updated_at
      where internal.app_account_issued_passwords.credential_version < excluded.credential_version
         or (
           internal.app_account_issued_passwords.credential_version = excluded.credential_version
           and internal.app_account_issued_passwords.source_command_key = excluded.source_command_key
           and internal.app_account_issued_passwords.ciphertext = excluded.ciphertext
         )
      returning * into saved;
      if saved.account_id is null then
        raise exception using errcode = '40001', message = 'account_password_escrow_version_conflict';
      end if;
    else
      insert into internal.app_account_issued_passwords (
        account_id, identity_key, credential_version, state, ciphertext,
        issued_by_account_id, issued_at, cleared_at, source_command_key,
        last_audit_id, updated_at
      ) values (
        p_account_id, rotated.identity_key, rotated.credential_version,
        'self_changed', null, p_actor_account_id, null, now(),
        lower(p_command_key), rotated.audit_entry_id, now()
      )
      on conflict (account_id) do update
      set identity_key = excluded.identity_key,
          credential_version = excluded.credential_version,
          state = 'self_changed',
          ciphertext = null,
          issued_by_account_id = coalesce(
            internal.app_account_issued_passwords.issued_by_account_id,
            excluded.issued_by_account_id
          ),
          issued_at = internal.app_account_issued_passwords.issued_at,
          cleared_at = excluded.cleared_at,
          source_command_key = excluded.source_command_key,
          last_audit_id = excluded.last_audit_id,
          updated_at = excluded.updated_at
      where internal.app_account_issued_passwords.credential_version <= excluded.credential_version
      returning * into saved;
      if saved.account_id is null then
        raise exception using errcode = '40001', message = 'account_password_escrow_version_conflict';
      end if;
    end if;
  end if;

  return query select rotated.command_key, rotated.applied,
    rotated.identity_key, rotated.credential_version,
    rotated.must_change_password, rotated.enabled,
    rotated.current_credential_version, rotated.currently_active,
    rotated.audit_entry_id;
end;
$$;

create or replace function public.seed_account_issued_password_escrow(
  p_secret text,
  p_command_key text,
  p_account_id uuid,
  p_credential_version bigint,
  p_ciphertext text,
  p_actor_account_id uuid
)
returns table (
  account_id uuid,
  credential_version bigint,
  applied boolean,
  audit_entry_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor internal.app_accounts%rowtype;
  target internal.app_accounts%rowtype;
  credential internal.app_account_credentials%rowtype;
  existing internal.app_account_issued_passwords%rowtype;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_command_key, '') !~ '^account-password-escrow:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_account_id is null or p_credential_version is null or p_credential_version < 1
     or char_length(coalesce(p_ciphertext, '')) > 920
     or coalesce(p_ciphertext, '') !~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22,}$'
     or p_actor_account_id is null then
    raise exception using errcode = '22023', message = 'invalid_account_password_escrow_seed';
  end if;
  select * into actor from internal.app_accounts a
  where a.account_id = p_actor_account_id for update;
  select * into target from internal.app_accounts a
  where a.account_id = p_account_id for update;
  select * into credential from internal.app_account_credentials c
  where c.account_id = p_account_id for update;
  if actor.account_id is null or actor.status <> 'active' or not actor.super_admin
     or target.account_id is null or credential.account_id is null
     or not credential.enabled or credential.credential_version <> p_credential_version
     or credential.identity_key <> target.identity_key then
    raise exception using errcode = '42501', message = 'account_password_escrow_seed_forbidden';
  end if;

  select * into existing from internal.app_account_issued_passwords e
  where e.account_id = target.account_id for update;
  if existing.account_id is not null then
    if existing.state = 'available'
       and existing.credential_version = credential.credential_version
       and existing.identity_key = target.identity_key
       and existing.source_command_key = lower(p_command_key)
       and existing.ciphertext = p_ciphertext then
      return query select existing.account_id, existing.credential_version,
        false, existing.last_audit_id;
      return;
    end if;
    raise exception using errcode = '23505', message = 'account_password_escrow_already_recorded';
  end if;

  audit_id := internal.append_operational_contract_audit(
    'account.issued_password_seeded', actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('credentialVersion', credential.credential_version)
  );
  insert into internal.app_account_issued_passwords (
    account_id, identity_key, credential_version, state, ciphertext,
    issued_by_account_id, issued_at, cleared_at, source_command_key,
    last_audit_id, updated_at
  ) values (
    target.account_id, target.identity_key, credential.credential_version,
    'available', p_ciphertext, actor.account_id, now(), null,
    lower(p_command_key), audit_id, now()
  );
  return query select target.account_id, credential.credential_version, true, audit_id;
end;
$$;

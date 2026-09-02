-- AES-GCM envelopes now use random nonces. Exact password-reset retries must
-- retain the envelope stored by the first successful command instead of
-- comparing a freshly encrypted envelope byte-for-byte.

create or replace function public.rotate_account_password_tx_v4(
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
    if rotated.applied then
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
        returning * into saved;
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
        where internal.app_account_issued_passwords.credential_version < excluded.credential_version
        returning * into saved;
      end if;
      if saved.account_id is null then
        raise exception using errcode = '40001', message = 'account_password_escrow_version_conflict';
      end if;
    else
      -- rotate_account_password_tx_v2 proved this is the exact original
      -- command. Reuse the envelope committed by that first request.
      select * into saved
      from internal.app_account_issued_passwords e
      where e.account_id = p_account_id
        and e.identity_key = rotated.identity_key
        and e.credential_version = rotated.credential_version
        and e.source_command_key = lower(p_command_key)
        and (
          (p_action = 'admin_reset' and e.state = 'available' and e.ciphertext is not null)
          or (p_action = 'self_change' and e.state = 'self_changed' and e.ciphertext is null)
        )
      for update;
      if saved.account_id is null then
        raise exception using errcode = '55000', message = 'account_password_escrow_replay_missing';
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

revoke all on function public.rotate_account_password_tx_v3(
  text, text, uuid, text, text, text, bigint, boolean, text, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.rotate_account_password_tx_v4(
  text, text, uuid, text, text, text, bigint, boolean, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.rotate_account_password_tx_v4(
  text, text, uuid, text, text, text, bigint, boolean, text, uuid, text
) to anon, authenticated;

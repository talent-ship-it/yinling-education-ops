-- Legacy password escrow used OPS_API_SECRET as its AES-GCM key. The
-- application now decrypts those envelopes only on an authenticated reveal
-- and immediately replaces them with an envelope under the dedicated key.

create or replace function public.rewrap_account_issued_password_escrow(
  p_secret text,
  p_account_id uuid,
  p_expected_credential_version bigint,
  p_expected_ciphertext text,
  p_rewrapped_ciphertext text,
  p_actor_account_id uuid
)
returns table (applied boolean, audit_entry_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor internal.app_accounts%rowtype;
  target internal.app_accounts%rowtype;
  credential internal.app_account_credentials%rowtype;
  escrow internal.app_account_issued_passwords%rowtype;
  locked_account internal.app_accounts%rowtype;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_account_id is null or p_actor_account_id is null
     or p_expected_credential_version is null or p_expected_credential_version < 1
     or char_length(coalesce(p_expected_ciphertext, '')) > 920
     or coalesce(p_expected_ciphertext, '') !~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22,}$'
     or char_length(coalesce(p_rewrapped_ciphertext, '')) > 920
     or coalesce(p_rewrapped_ciphertext, '') !~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22,}$'
     or p_rewrapped_ciphertext = p_expected_ciphertext then
    raise exception using errcode = '22023', message = 'invalid_account_password_escrow_rewrap';
  end if;

  -- Lock both account rows in one stable order. Two administrators revealing
  -- one another's issued passwords therefore cannot acquire inverse locks.
  for locked_account in
    select * from internal.app_accounts a
    where a.account_id in (p_actor_account_id, p_account_id)
    order by a.account_id
    for update
  loop
    if locked_account.account_id = p_actor_account_id then actor := locked_account; end if;
    if locked_account.account_id = p_account_id then target := locked_account; end if;
  end loop;
  select * into credential from internal.app_account_credentials c
  where c.account_id = p_account_id for update;
  select * into escrow from internal.app_account_issued_passwords e
  where e.account_id = p_account_id for update;

  if actor.account_id is null or actor.status <> 'active' or not actor.super_admin
     or target.account_id is null or target.status <> 'active'
     or credential.account_id is null or not credential.enabled
     or credential.credential_version <> p_expected_credential_version
     or credential.identity_key <> target.identity_key
     or escrow.account_id is null or escrow.state <> 'available'
     or escrow.identity_key <> target.identity_key
     or escrow.credential_version <> p_expected_credential_version
     or escrow.ciphertext <> p_expected_ciphertext then
    return query select false, null::uuid;
    return;
  end if;

  audit_id := internal.append_operational_contract_audit(
    'account.issued_password_rewrapped', actor.account_name, 'account', target.account_id::text,
    jsonb_build_object('credentialVersion', credential.credential_version)
  );
  update internal.app_account_issued_passwords e
  set ciphertext = p_rewrapped_ciphertext,
      last_audit_id = audit_id,
      updated_at = now()
  where e.account_id = target.account_id
    and e.credential_version = p_expected_credential_version
    and e.ciphertext = p_expected_ciphertext;
  if not found then
    return query select false, null::uuid;
    return;
  end if;

  return query select true, audit_id;
end;
$$;

revoke all on function public.rewrap_account_issued_password_escrow(
  text, uuid, bigint, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.rewrap_account_issued_password_escrow(
  text, uuid, bigint, text, text, uuid
) to anon, authenticated;

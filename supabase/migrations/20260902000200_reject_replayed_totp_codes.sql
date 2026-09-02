-- A valid TOTP step is single-use per account. The compare-and-set happens in
-- the database so concurrent requests cannot both establish sessions.

alter table internal.app_account_mfa
  add column if not exists last_accepted_totp_counter bigint
  check (last_accepted_totp_counter is null or last_accepted_totp_counter >= 0);

create or replace function internal.reset_account_mfa_totp_counter()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.last_accepted_totp_counter := null;
  elsif new.secret_ciphertext is distinct from old.secret_ciphertext then
    new.last_accepted_totp_counter := null;
  end if;
  return new;
end;
$$;

drop trigger if exists reset_account_mfa_totp_counter on internal.app_account_mfa;
create trigger reset_account_mfa_totp_counter
before insert or update of secret_ciphertext on internal.app_account_mfa
for each row execute function internal.reset_account_mfa_totp_counter();

create or replace function public.consume_account_mfa_totp(
  p_secret text,
  p_identity_key text,
  p_expected_mfa_version bigint,
  p_counter bigint
)
returns table (accepted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target internal.app_accounts%rowtype;
  mfa internal.app_account_mfa%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if coalesce(p_identity_key, '') !~ '^[a-f0-9]{64}$'
     or p_expected_mfa_version is null or p_expected_mfa_version < 1
     or p_counter is null or p_counter < 0 then
    raise exception using errcode = '22023', message = 'invalid_account_mfa_totp';
  end if;

  select * into target
  from internal.app_accounts a
  where a.identity_key = p_identity_key and a.status = 'active'
  for update;
  if target.account_id is null then
    return query select false;
    return;
  end if;

  select * into mfa
  from internal.app_account_mfa m
  where m.account_id = target.account_id
  for update;
  -- Setup confirmation consumes its code before enabling MFA, while login
  -- consumes codes from an enabled row. Both paths share this monotonic
  -- counter so a setup code cannot be replayed immediately after activation.
  if mfa.account_id is null or mfa.mfa_version <> p_expected_mfa_version
     or p_counter <= coalesce(mfa.last_accepted_totp_counter, -1) then
    return query select false;
    return;
  end if;

  update internal.app_account_mfa m
  set last_accepted_totp_counter = p_counter
  where m.account_id = target.account_id;
  return query select true;
end;
$$;

revoke all on function internal.reset_account_mfa_totp_counter() from public, anon, authenticated, service_role;
revoke all on function public.consume_account_mfa_totp(text, text, bigint, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_account_mfa_totp(text, text, bigint, bigint)
  to anon, authenticated;

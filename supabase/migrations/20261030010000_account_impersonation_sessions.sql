-- Only a live super-admin session may create a short-lived target session.
-- Business routes continue to use the existing target account permissions.
begin;

create or replace function public.create_account_impersonation_session(
  p_secret text,
  p_actor_account_id uuid,
  p_actor_session_id uuid,
  p_target_account_id uuid,
  p_session_id uuid,
  p_token_hash text,
  p_expected_credential_version bigint,
  p_expected_access_version bigint,
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
  checked_at timestamptz := clock_timestamp();
  actor internal.app_accounts%rowtype;
  actor_session internal.app_account_sessions%rowtype;
  target_session record;
  audit_id uuid;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_actor_account_id is null or p_actor_session_id is null
     or p_target_account_id is null or p_target_account_id = p_actor_account_id
     or p_session_id is null or p_session_id = p_actor_session_id
     or coalesce(p_token_hash, '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_account_impersonation';
  end if;

  -- Lock both accounts in a stable order. Never wait while holding them:
  -- live session reads take session -> account locks, while security writes
  -- take account -> session locks. A busy snapshot is retried by the caller.
  perform a.account_id from internal.app_accounts a
  where a.account_id in (p_actor_account_id, p_target_account_id)
  order by a.account_id for update nowait;
  select * into actor from internal.app_accounts a
  where a.account_id = p_actor_account_id;
  select * into actor_session from internal.app_account_sessions s
  where s.session_id = p_actor_session_id and s.account_id = p_actor_account_id for update nowait;
  if actor.account_id is null or actor.status <> 'active' or not actor.super_admin
     or actor.account_role <> 'admin' or actor_session.session_id is null
     or actor_session.revoked_at is not null
     or actor_session.absolute_expires_at <= checked_at
     or actor_session.idle_expires_at <= checked_at
     or actor_session.access_version <> actor.access_version then
    raise exception using errcode = '42501', message = 'account_impersonation_forbidden';
  end if;

  -- Explicit delegated authentication. The target's MFA settings are unchanged.
  -- The ordinary session creator atomically checks target status and versions.
  select * into target_session from public.create_account_session(
    p_secret, p_session_id, p_token_hash, p_target_account_id,
    p_expected_credential_version, p_expected_access_version, true,
    left('[Admin account switch] ' || coalesce(p_user_agent, ''), 512)
  );
  if target_session.session_id is null then
    raise exception using errcode = '55000', message = 'account_impersonation_session_missing';
  end if;
  update internal.app_account_sessions s
  set absolute_expires_at = least(s.absolute_expires_at, actor_session.absolute_expires_at, checked_at + interval '1 hour'),
      idle_expires_at = least(s.idle_expires_at, actor_session.absolute_expires_at, checked_at + interval '1 hour')
  where s.session_id = p_session_id;
  audit_id := internal.append_operational_contract_audit(
    'account.impersonation_started', actor.account_name, 'account', p_target_account_id::text,
    jsonb_build_object('actorAccountId', p_actor_account_id, 'actorSessionId', p_actor_session_id,
      'targetSessionId', p_session_id, 'authenticationMethod', 'super_admin_delegation')
  );
  return query select s.session_id, s.account_id, s.absolute_expires_at,
    s.idle_expires_at, s.access_version, audit_id
  from internal.app_account_sessions s where s.session_id = p_session_id;
end;
$$;
revoke all on function public.create_account_impersonation_session(text, uuid, uuid, uuid, uuid, text, bigint, bigint, text) from public;
grant execute on function public.create_account_impersonation_session(text, uuid, uuid, uuid, uuid, text, bigint, bigint, text) to anon;

commit;

\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

insert into internal.app_accounts(account_id,identity_key,account_name,account_role,super_admin,created_by,updated_by) values
('11111111-1111-4111-8111-111111111111',repeat('1',64),'Nixon','admin',true,'fixture','fixture'),
('22222222-2222-4222-8222-222222222222',repeat('2',64),'Teacher A','teacher',false,'fixture','fixture'),
('33333333-3333-4333-8333-333333333333',repeat('3',64),'Staff A','staff',false,'fixture','fixture');

create function pg_temp.switch_session(actor uuid, actor_session uuid, target uuid, version bigint default 1, credential bigint default 0, secret text default 'materials-fixture-secret')
returns uuid language plpgsql as $$
declare id uuid := gen_random_uuid(); result uuid;
begin
  select session_id into result from public.create_account_impersonation_session(
    secret,actor,actor_session,target,id,replace(id::text,'-','') || replace(id::text,'-',''),credential,version,'SQL fixture');
  return result;
end $$;

create function pg_temp.expect_switch_failure(actor uuid, actor_session uuid, target uuid, expected text, version bigint default 1, credential bigint default 0, secret text default 'materials-fixture-secret')
returns void language plpgsql as $$
begin
  begin
    perform pg_temp.switch_session(actor,actor_session,target,version,credential,secret);
  exception when others then
    if sqlerrm = expected then return; end if;
    raise;
  end;
  raise exception 'Expected switch rejection %',expected;
end $$;

do $$
declare
  admin uuid := '11111111-1111-4111-8111-111111111111';
  teacher uuid := '22222222-2222-4222-8222-222222222222';
  staff uuid := '33333333-3333-4333-8333-333333333333';
  admin_session uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  staff_session uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  delegated uuid;
  target_state record;
begin
  perform public.create_account_session('materials-fixture-secret',admin_session,repeat('a',64),admin,0,1,true,'fixture admin');
  perform public.create_account_session('materials-fixture-secret',staff_session,repeat('b',64),staff,0,1,true,'fixture staff');
  perform pg_temp.expect_switch_failure(admin,admin_session,teacher,'invalid_ops_secret',1,0,'wrong');
  perform pg_temp.expect_switch_failure(staff,staff_session,teacher,'account_impersonation_forbidden');
  perform pg_temp.expect_switch_failure(admin,admin_session,admin,'invalid_account_impersonation');
  perform pg_temp.expect_switch_failure(admin,staff_session,teacher,'account_impersonation_forbidden');
  perform pg_temp.expect_switch_failure(admin,admin_session,teacher,'account_login_state_stale',2);
  perform pg_temp.expect_switch_failure(admin,admin_session,teacher,'account_login_state_stale',1,2);

  update internal.app_account_sessions set absolute_expires_at=now()+interval '20 minutes',idle_expires_at=now()+interval '20 minutes' where session_id=admin_session;
  delegated := pg_temp.switch_session(admin,admin_session,teacher);
  if not exists(select 1 from internal.app_account_sessions s where s.session_id=delegated and s.account_id=teacher
    and s.absolute_expires_at <= now()+interval '20 minutes' and s.idle_expires_at<=s.absolute_expires_at and s.mfa_verified) then
    raise exception 'Delegated session did not inherit the bounded target identity';
  end if;
  select * into target_state from public.read_account_session('materials-fixture-secret',replace(delegated::text,'-','') || replace(delegated::text,'-',''));
  if target_state.account_id<>teacher or target_state.account_role<>'teacher' or '*'=any(target_state.permissions) then
    raise exception 'Target session inherited administrator identity or permission';
  end if;
  if not exists(select 1 from internal.operational_contract_audit where action='account.impersonation_started'
    and actor='Nixon' and target_id=teacher::text and metadata->>'targetSessionId'=delegated::text) then
    raise exception 'Missing switch actor audit';
  end if;

  update internal.app_accounts set status='disabled' where account_id=teacher;
  perform pg_temp.expect_switch_failure(admin,admin_session,teacher,'account_login_state_stale');
  if exists(select 1 from public.read_account_session('materials-fixture-secret',replace(delegated::text,'-','') || replace(delegated::text,'-',''))) then
    raise exception 'Disabled target session remained active';
  end if;
  update internal.app_accounts set status='active' where account_id=teacher;
  update internal.app_account_sessions set revoked_at=now() where session_id=admin_session;
  perform pg_temp.expect_switch_failure(admin,admin_session,teacher,'account_impersonation_forbidden');
  update internal.app_account_sessions set revoked_at=null,idle_expires_at=now()-interval '1 second' where session_id=admin_session;
  perform pg_temp.expect_switch_failure(admin,admin_session,teacher,'account_impersonation_forbidden');
  update internal.app_account_sessions set idle_expires_at=now()+interval '10 minutes',access_version=2 where session_id=admin_session;
  perform pg_temp.expect_switch_failure(admin,admin_session,teacher,'account_impersonation_forbidden');
  if not has_function_privilege('anon','public.create_account_impersonation_session(text,uuid,uuid,uuid,uuid,text,bigint,bigint,text)','execute') then
    raise exception 'RPC grant is missing';
  end if;
end $$;

select 'account impersonation runtime: PASS';

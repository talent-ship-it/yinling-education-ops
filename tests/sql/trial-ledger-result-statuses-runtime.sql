\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

begin;
create schema internal;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end;
$$;

\ir ../../supabase/migrations/20261021074408_add_trial_cancelled_and_nil_statuses.sql
\ir ../../supabase/migrations/20261021074408_add_trial_cancelled_and_nil_statuses.sql

do $$
declare
  status text;
begin
  foreach status in array array[
    '试听成功', '试听失败', '有希望报名', '试听未进行', '在读试听成功', '在读试听失败',
    '被家长取消', 'NIL'
  ] loop
    if internal.trial_ledger_value_valid('resultStatus', to_jsonb(status)) is distinct from true then
      raise exception 'trial_result_status_rejected: %', status;
    end if;
  end loop;
  foreach status in array array['已完成', '已取消', 'unknown', 'nil', ' NIL ', ''] loop
    if internal.trial_ledger_value_valid('resultStatus', to_jsonb(status)) is distinct from false then
      raise exception 'invalid_trial_result_status_accepted: %', status;
    end if;
  end loop;
  if internal.trial_ledger_value_valid('resultStatus', 'false'::jsonb) is distinct from false
     or internal.trial_ledger_value_valid('resultStatus', 'null'::jsonb) is distinct from true
     or internal.trial_ledger_value_valid('trialPaid', 'false'::jsonb) is distinct from true
     or internal.trial_ledger_value_valid('trialPaid', '"NIL"'::jsonb) is distinct from false
     or internal.trial_ledger_value_valid('planner', '"NIL"'::jsonb) is distinct from false
     or internal.trial_ledger_value_valid('unknown', 'null'::jsonb) is distinct from false then
    raise exception 'trial_ledger_field_validation_changed';
  end if;
  if exists (
    select 1 from pg_proc p, lateral aclexplode(p.proacl) acl
    where p.oid = 'internal.trial_ledger_value_valid(text,jsonb)'::regprocedure
      and acl.privilege_type = 'EXECUTE' and acl.grantee <> p.proowner
  ) then
    raise exception 'trial_ledger_validator_exposed';
  end if;
end;
$$;
rollback;

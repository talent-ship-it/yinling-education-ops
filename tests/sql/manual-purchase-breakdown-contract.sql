\ir assert-disposable-database.sql
-- Run after applying 20260819101000_allow_manual_purchase_hours_breakdown.sql.
-- This is a read-only contract check: it does not rewrite legacy/JWB data.
do $contract$
declare
  writer_definition text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.ops_state'::pg_catalog.regclass
      and trigger_row.tgname = 'ops_state_validate_manual_package_breakdown'
      and not trigger_row.tgisinternal
  ) then
    raise exception using errcode = '55000', message = 'manual_purchase_breakdown_trigger_missing';
  end if;

  select pg_catalog.pg_get_functiondef(p.oid)
    into writer_definition
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'put_ops_state'
    and p.pronargs = 5
    and p.proargtypes = array[
      'text'::pg_catalog.regtype,
      'text'::pg_catalog.regtype,
      'jsonb'::pg_catalog.regtype,
      'bigint'::pg_catalog.regtype,
      'text'::pg_catalog.regtype
    ]::pg_catalog.oidvector;
  if writer_definition is null then
    raise exception using errcode = '55000', message = 'manual_purchase_breakdown_writer_missing';
  end if;
end;
$contract$;

-- The trigger must use `IS DISTINCT FROM` for JSON type checks. A missing
-- `hours` key yields SQL NULL from jsonb_typeof(); plain `<> 'number'` would
-- therefore make the IF condition NULL and accidentally accept the record.
do $contract_missing_hours$
declare
  validator_definition text;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into validator_definition
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'internal'
    and p.proname = 'validate_ops_state_manual_package_breakdown'
    and p.pronargs = 0;

  if validator_definition is null then
    raise exception using errcode = '55000', message = 'manual_purchase_breakdown_validator_missing';
  end if;
  if validator_definition not like '%jsonb_typeof(purchase_item -> ''purchasedHours'') is distinct from ''number''%'
     or validator_definition not like '%jsonb_typeof(purchase_item -> ''bonusHours'') is distinct from ''number''%'
     or validator_definition not like '%jsonb_typeof(purchase_item -> ''hours'') is distinct from ''number''%' then
    raise exception using errcode = '55000', message = 'manual_purchase_breakdown_missing_hours_not_fail_closed';
  end if;
end;
$contract_missing_hours$;

-- The six-argument canonical import commit must carry forward structured
-- manual purchases while retaining the later roster/security patches.
do $contract_student_import_commit$
declare
  commit_oid oid;
  commit_definition text;
  commit_security_definer boolean;
  commit_config text[];
  commit_acl text;
begin
  select p.oid,
    pg_catalog.pg_get_functiondef(p.oid),
    p.prosecdef,
    p.proconfig,
    coalesce(pg_catalog.array_to_string(p.proacl, E'\n'), '')
    into commit_oid, commit_definition, commit_security_definer, commit_config, commit_acl
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'commit_student_import_plan_atomic'
    and p.pronargs = 6
    and p.proargtypes = array[
      'text'::pg_catalog.regtype,
      'text'::pg_catalog.regtype,
      'bigint'::pg_catalog.regtype,
      'jsonb'::pg_catalog.regtype,
      'jsonb'::pg_catalog.regtype,
      'text'::pg_catalog.regtype
    ]::pg_catalog.oidvector;
  if commit_oid is null then
    raise exception using errcode = '55000', message = 'manual_purchase_breakdown_commit_writer_missing';
  end if;
  if position('purchase_item - ''id'' - ''purchasedAt'' - ''hours'' - ''purchasedHours'' - ''bonusHours'' - ''note''' in commit_definition) = 0
     or position('purchase_item - ''id'' - ''purchasedAt'' - ''hours'' - ''note''' in commit_definition) > 0 then
    raise exception using errcode = '55000', message = 'student_import_commit_purchase_breakdown_not_patched';
  end if;
  if position('eligible_master_row ->> ''status'' <> ''不活跃 + 无课时''' in commit_definition) = 0 then
    raise exception using errcode = '55000', message = 'student_import_commit_inactive_roster_patch_lost';
  end if;
  if commit_security_definer is not true
     or commit_config is null
     or not ('statement_timeout=30s' = any(commit_config))
     or not exists (select 1 from unnest(commit_config) config where config like 'search_path=%')
     or commit_acl = '' then
    raise exception using errcode = '55000', message = 'student_import_commit_security_or_acl_contract_failed';
  end if;
end;
$contract_student_import_commit$;

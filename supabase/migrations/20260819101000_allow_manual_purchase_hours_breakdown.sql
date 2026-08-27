-- Manual lesson-package purchases now persist purchasedHours and bonusHours as
-- structured fields. Legacy/JWB purchases intentionally remain valid without
-- either field; this migration never rewrites existing ops_state payloads and
-- does not change any Jiaowubao source/projection input contract.

create or replace function internal.validate_ops_state_manual_package_breakdown()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  student_item jsonb;
  package_item jsonb;
  purchase_item jsonb;
  has_purchased boolean;
  has_bonus boolean;
begin
  if new.entity <> 'students' or jsonb_typeof(new.payload) <> 'array' then
    return new;
  end if;

  for student_item in select value from jsonb_array_elements(new.payload)
  loop
    for package_item in select value from jsonb_array_elements(coalesce(student_item -> 'lessonPackages', '[]'::jsonb))
    loop
      for purchase_item in select value from jsonb_array_elements(coalesce(package_item -> 'purchaseRecords', '[]'::jsonb))
      loop
        has_purchased := purchase_item ? 'purchasedHours';
        has_bonus := purchase_item ? 'bonusHours';
        if has_purchased <> has_bonus then
          raise exception using errcode = '22023', message = 'invalid_manual_purchase_breakdown';
        end if;
        if not has_purchased then
          continue;
        end if;
        if jsonb_typeof(purchase_item -> 'purchasedHours') is distinct from 'number'
           or jsonb_typeof(purchase_item -> 'bonusHours') is distinct from 'number'
           or jsonb_typeof(purchase_item -> 'hours') is distinct from 'number'
           or (purchase_item ->> 'purchasedHours')::numeric < 0
           or (purchase_item ->> 'bonusHours')::numeric < 0
           or round((purchase_item ->> 'purchasedHours')::numeric
             + (purchase_item ->> 'bonusHours')::numeric, 6)
             <> round((purchase_item ->> 'hours')::numeric, 6) then
          raise exception using errcode = '22023', message = 'invalid_manual_purchase_breakdown';
        end if;
      end loop;
    end loop;
  end loop;
  return new;
end;
$function$;

revoke all on function internal.validate_ops_state_manual_package_breakdown() from public;

drop trigger if exists ops_state_validate_manual_package_breakdown on public.ops_state;
create trigger ops_state_validate_manual_package_breakdown
before insert or update of entity, payload on public.ops_state
for each row execute function internal.validate_ops_state_manual_package_breakdown();

-- Some older deployments put the generic exact-key check inside
-- `put_ops_state`; others delegate all shape checks to application code and
-- have no such marker in the function body. Extend the former in place, but
-- leave the latter unchanged because the trigger above is the database
-- invariant. The guard prevents silently rewriting an unknown function shape.
do $migration$
declare
  target_oid oid;
  original_definition text;
  updated_definition text;
  exact_key_suffix text := '- ''id'' - ''purchasedAt'' - ''hours'' - ''note''';
begin
  select p.oid
    into target_oid
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'put_ops_state'
    and p.pronargs = 5
    and p.proargtypes = ARRAY[
      'text'::pg_catalog.regtype,
      'text'::pg_catalog.regtype,
      'jsonb'::pg_catalog.regtype,
      'bigint'::pg_catalog.regtype,
      'text'::pg_catalog.regtype
    ]::pg_catalog.oidvector;

  if target_oid is null then
    raise exception using errcode = '42883', message = 'put_ops_state_function_not_found';
  end if;

  original_definition := pg_catalog.pg_get_functiondef(target_oid);
  if position(exact_key_suffix in original_definition) > 0 then
    updated_definition := replace(
      original_definition,
      exact_key_suffix,
      '- ''id'' - ''purchasedAt'' - ''hours'' - ''purchasedHours'' - ''bonusHours'' - ''note'''
    );
    execute updated_definition;
  end if;
end;
$migration$;

-- The canonical student-import commit also accepts the complete current
-- students payload.  Its live exact-key validator therefore has to allow the
-- structured fields when it carries a pre-existing manual package forward;
-- otherwise a later Jiaowubao import would reject an otherwise valid manual
-- purchase.  Patch only the deployed six-argument function, and require the
-- post-180012 inactive-roster marker before changing anything.  This keeps
-- the patch fail-closed against an unknown function body and leaves the JWB
-- source-input contract untouched.
do $student_import_manual_breakdown_patch$
declare
  target_oid oid;
  original_definition text;
  updated_definition text;
  old_key_anchor text := 'purchase_item - ''id'' - ''purchasedAt'' - ''hours'' - ''note''';
  new_key_anchor text := 'purchase_item - ''id'' - ''purchasedAt'' - ''hours'' - ''purchasedHours'' - ''bonusHours'' - ''note''';
  old_key_count integer;
  inactive_anchor text := 'eligible_master_row ->> ''status'' <> ''不活跃 + 无课时''';
  inactive_anchor_count integer;
  original_security_definer boolean;
  current_security_definer boolean;
  original_config text[];
  current_config text[];
  original_acl text;
  current_acl text;
begin
  select p.oid,
    p.prosecdef,
    p.proconfig,
    coalesce(pg_catalog.array_to_string(p.proacl, E'\n'), '')
    into target_oid, original_security_definer, original_config, original_acl
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'commit_student_import_plan_atomic'
    and p.pronargs = 6
    and p.proargtypes = ARRAY[
      'text'::pg_catalog.regtype,
      'text'::pg_catalog.regtype,
      'bigint'::pg_catalog.regtype,
      'jsonb'::pg_catalog.regtype,
      'jsonb'::pg_catalog.regtype,
      'text'::pg_catalog.regtype
    ]::pg_catalog.oidvector;

  if target_oid is null then
    raise exception using errcode = '42883', message = 'student_import_commit_function_not_found';
  end if;

  original_definition := pg_catalog.pg_get_functiondef(target_oid);
  inactive_anchor_count := (length(original_definition) - length(replace(original_definition, inactive_anchor, '')))
    / length(inactive_anchor);
  if inactive_anchor_count <> 3 then
    raise exception using errcode = 'P0001', message = 'student_import_commit_inactive_roster_anchor_mismatch';
  end if;

  old_key_count := (length(original_definition) - length(replace(original_definition, old_key_anchor, '')))
    / length(old_key_anchor);
  if old_key_count <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_commit_purchase_key_anchor_mismatch';
  end if;
  updated_definition := replace(original_definition, old_key_anchor, new_key_anchor);
  execute updated_definition;

  -- CREATE OR REPLACE preserves ACLs, but verify that fact and all settings
  -- installed by the later timeout/security migration instead of assuming it.
  select p.prosecdef,
    p.proconfig,
    coalesce(pg_catalog.array_to_string(p.proacl, E'\n'), '')
    into current_security_definer, current_config, current_acl
  from pg_catalog.pg_proc p
  where p.oid = target_oid;
  if current_security_definer is distinct from original_security_definer
     or current_config is distinct from original_config
     or current_acl is distinct from original_acl then
    raise exception using errcode = 'P0001', message = 'student_import_commit_security_or_acl_changed';
  end if;
end;
$student_import_manual_breakdown_patch$;

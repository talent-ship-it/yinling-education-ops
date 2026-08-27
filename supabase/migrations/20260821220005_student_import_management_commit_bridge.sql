-- Private Management API bridge for the server-owned formal student import.
--
-- The browser-facing commit remains OPS-secret guarded.  This one-time owner
-- path copies the live canonical function definitions into internal,
-- postgres-only invoker functions at migration time.  Copying the deployed
-- definitions keeps every later canonical lock, OCC check, replay check,
-- source-revision check, projection check and audit write in the management
-- path without maintaining a second hand-copied implementation.

create or replace function internal.student_import_management_session()
returns boolean
language plpgsql
security invoker
set search_path = ''
as $student_import_management_session$
begin
  if session_user <> 'postgres' or current_user <> 'postgres' then
    raise exception using errcode = '42501',
      message = 'student_import_management_postgres_session_required';
  end if;
  return true;
end;
$student_import_management_session$;

revoke all on function internal.student_import_management_session()
  from public, anon, authenticated, service_role;
alter function internal.student_import_management_session() owner to postgres;

-- Clone the current source snapshot function into an invoker-only internal
-- helper.  It returns the same server-owned source evidence as the public
-- preview, including durable number reservations and attachment references,
-- but has no public/anon/authenticated/service_role grant.
do $student_import_management_source_clone$
declare
  definition text;
  updated_definition text;
  guard_anchor text := 'if not internal.verify_ops_' || 'secret(p_secret) then';
  security_definer_anchor text := 'SECURITY ' || 'DEFINER';
begin
  select pg_catalog.pg_get_functiondef(
    'public.get_latest_student_import_source_rows(text)'::pg_catalog.regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_management_source_function_missing';
  end if;

  updated_definition := pg_catalog.regexp_replace(
    definition,
    'CREATE OR REPLACE FUNCTION public\\.get_latest_student_import_source_rows\\(\\s*p_secret text\\s*\\)',
    'CREATE OR REPLACE FUNCTION internal.student_import_management_source_snapshot()',
    1, 1, 'in'
  );
  if updated_definition = definition then
    updated_definition := pg_catalog.regexp_replace(
      definition,
      'CREATE OR REPLACE FUNCTION public[.]get_latest_student_import_source_rows[(][[:space:]]*p_secret text[[:space:]]*[)]',
      'CREATE OR REPLACE FUNCTION internal.student_import_management_source_snapshot()',
      1, 1, 'in'
    );
  end if;
  if updated_definition = definition then
    raise exception using errcode = 'P0001', message = 'student_import_management_source_signature_mismatch';
  end if;
  if (length(updated_definition) - length(replace(updated_definition, guard_anchor, '')))
      / length(guard_anchor) <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_management_source_secret_anchor_mismatch';
  end if;
  updated_definition := replace(
    updated_definition,
    guard_anchor,
    'if session_user <> ''postgres'' or current_user <> ''postgres'' then'
  );
  updated_definition := pg_catalog.regexp_replace(
    updated_definition, security_definer_anchor, 'SECURITY INVOKER', 1, 0, 'i'
  );
  if position('p_secret' in updated_definition) > 0 then
    raise exception using errcode = 'P0001', message = 'student_import_management_source_secret_parameter_remaining';
  end if;
  execute updated_definition;
end;
$student_import_management_source_clone$;

revoke all on function internal.student_import_management_source_snapshot()
  from public, anon, authenticated, service_role;
alter function internal.student_import_management_source_snapshot() owner to postgres;

-- Only the small reference projection crosses the Management API boundary.
-- The formal commit itself re-reads and locks the complete rows in PostgreSQL;
-- this projection is sufficient for the TypeScript planner to preserve every
-- referenced student ID and the bookings version without copying operational
-- payloads into the CLI process.
create or replace function internal.student_import_management_snapshot()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $student_import_management_snapshot$
with required(entity) as (
  values
    ('bookings'::text), ('files'::text), ('lpItems'::text),
    ('messages'::text), ('operations'::text), ('payroll'::text),
    ('renewals'::text), ('tasks'::text)
), reference_rows as (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'entity', required.entity,
        'version', state.version,
        'updated_at', state.updated_at,
        'updated_by', state.updated_by,
        'payload', case
          when state.payload is null then null
          when jsonb_typeof(state.payload) is distinct from 'array' then state.payload
          else coalesce((
            select jsonb_agg(
              case
                when jsonb_typeof(item.value) is distinct from 'object' then item.value
                else jsonb_build_object('studentId', item.value -> 'studentId')
                  || case
                    when item.value ? 'occurrenceOverrides' then jsonb_build_object(
                      'occurrenceOverrides', case
                        when required.entity <> 'bookings' then item.value -> 'occurrenceOverrides'
                        when jsonb_typeof(item.value -> 'occurrenceOverrides') is distinct from 'array'
                          then item.value -> 'occurrenceOverrides'
                        else coalesce((
                          select jsonb_agg(
                            case
                              when jsonb_typeof(override_item.value) is distinct from 'object'
                                then override_item.value
                              else jsonb_build_object('studentId', override_item.value -> 'studentId')
                            end
                            order by override_item.ordinality
                          )
                          from jsonb_array_elements(item.value -> 'occurrenceOverrides')
                            with ordinality as override_item(value, ordinality)
                        ), '[]'::jsonb)
                      end
                    ) else '{}'::jsonb
                  end
              end
              order by item.ordinality
            )
            from jsonb_array_elements(state.payload) with ordinality as item(value, ordinality)
          ), '[]'::jsonb)
        end
      )
      order by required.entity
    ),
    '[]'::jsonb
  ) as rows
  from required
  left join public.ops_state state on state.entity = required.entity
)
select jsonb_build_object(
  'sourceSnapshot', internal.student_import_management_source_snapshot(),
  'studentsRow', (
    select pg_catalog.to_jsonb(state)
    from public.ops_state state
    where state.entity = 'students'
  ),
  'referenceRows', reference_rows.rows
)
from reference_rows
where internal.student_import_management_session();
$student_import_management_snapshot$;

revoke all on function internal.student_import_management_snapshot()
  from public, anon, authenticated, service_role;
alter function internal.student_import_management_snapshot() owner to postgres;

-- Clone the live canonical atomic commit into an invoker-only internal
-- function, removing only the OPS-secret parameter/guard and replacing it
-- with a postgres-session check.  Every other byte of the deployed function
-- remains the source of truth for this one-time management execution path.
do $student_import_management_commit_clone$
declare
  definition text;
  updated_definition text;
  guard_anchor text := 'if not internal.verify_ops_' || 'secret(p_secret) then';
  security_definer_anchor text := 'SECURITY ' || 'DEFINER';
begin
  select pg_catalog.pg_get_functiondef(
    'public.commit_student_import_plan_atomic(text,text,bigint,jsonb,jsonb,text)'::pg_catalog.regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_management_commit_function_missing';
  end if;

  updated_definition := pg_catalog.regexp_replace(
    definition,
    $student_import_management_commit_signature_pattern$CREATE OR REPLACE FUNCTION public\.commit_student_import_plan_atomic\(\s*p_secret text\s*,\s*p_plan_fingerprint text\s*,\s*p_expected_student_version bigint\s*,\s*p_source_revisions jsonb\s*,\s*p_students jsonb\s*,\s*p_actor text\s*\)$student_import_management_commit_signature_pattern$,
    $student_import_management_commit_signature$CREATE OR REPLACE FUNCTION internal.student_import_management_commit(
  p_plan_fingerprint text,
  p_expected_student_version bigint,
  p_source_revisions jsonb,
  p_students jsonb,
  p_actor text
)$student_import_management_commit_signature$,
    1, 1, 'in'
  );
  if updated_definition = definition then
    updated_definition := pg_catalog.regexp_replace(
      definition,
      'CREATE OR REPLACE FUNCTION public[.]commit_student_import_plan_atomic[(][[:space:]]*p_secret text[[:space:]]*,[[:space:]]*p_plan_fingerprint text[[:space:]]*,[[:space:]]*p_expected_student_version bigint[[:space:]]*,[[:space:]]*p_source_revisions jsonb[[:space:]]*,[[:space:]]*p_students jsonb[[:space:]]*,[[:space:]]*p_actor text[[:space:]]*[)]',
      $student_import_management_commit_signature_fallback$CREATE OR REPLACE FUNCTION internal.student_import_management_commit(
  p_plan_fingerprint text,
  p_expected_student_version bigint,
  p_source_revisions jsonb,
  p_students jsonb,
  p_actor text
)$student_import_management_commit_signature_fallback$,
      1, 1, 'in'
    );
  end if;
  if updated_definition = definition then
    raise exception using errcode = 'P0001', message = 'student_import_management_commit_signature_mismatch';
  end if;
  if (length(updated_definition) - length(replace(updated_definition, guard_anchor, '')))
      / length(guard_anchor) <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_management_commit_secret_anchor_mismatch';
  end if;
  updated_definition := replace(
    updated_definition,
    guard_anchor,
    'if session_user <> ''postgres'' or current_user <> ''postgres'' then'
  );
  updated_definition := pg_catalog.regexp_replace(
    updated_definition, security_definer_anchor, 'SECURITY INVOKER', 1, 0, 'i'
  );
  if position('p_secret' in updated_definition) > 0 then
    raise exception using errcode = 'P0001', message = 'student_import_management_commit_secret_parameter_remaining';
  end if;
  execute updated_definition;
end;
$student_import_management_commit_clone$;

revoke all on function internal.student_import_management_commit(
  text, bigint, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
alter function internal.student_import_management_commit(
  text, bigint, jsonb, jsonb, text
) owner to postgres;

-- Lost-response recovery is replay-first.  The CLI can submit the opaque plan
-- fingerprint and original student version without recomputing a new plan;
-- this clone preserves the canonical replay lock/evidence checks.
do $student_import_management_replay_clone$
declare
  definition text;
  updated_definition text;
  guard_anchor text := 'if not internal.verify_ops_' || 'secret(p_secret) then';
  security_definer_anchor text := 'SECURITY ' || 'DEFINER';
begin
  select pg_catalog.pg_get_functiondef(
    'public.get_student_import_commit_replay_result(text,text,bigint,text)'::pg_catalog.regprocedure
  ) into definition;
  if definition is null then
    raise exception using errcode = 'P0001', message = 'student_import_management_replay_function_missing';
  end if;

  updated_definition := pg_catalog.regexp_replace(
    definition,
    'CREATE OR REPLACE FUNCTION public[.]get_student_import_commit_replay_result[(][[:space:]]*p_secret text[[:space:]]*,[[:space:]]*p_plan_fingerprint text[[:space:]]*,[[:space:]]*p_expected_student_version bigint[[:space:]]*,[[:space:]]*p_actor text[[:space:]]*[)]',
    $student_import_management_replay_signature$CREATE OR REPLACE FUNCTION internal.student_import_management_replay(
  p_plan_fingerprint text,
  p_expected_student_version bigint,
  p_actor text
)$student_import_management_replay_signature$,
    1, 1, 'in'
  );
  if updated_definition = definition then
    raise exception using errcode = 'P0001', message = 'student_import_management_replay_signature_mismatch';
  end if;
  if (length(updated_definition) - length(replace(updated_definition, guard_anchor, '')))
      / length(guard_anchor) <> 1 then
    raise exception using errcode = 'P0001', message = 'student_import_management_replay_secret_anchor_mismatch';
  end if;
  updated_definition := replace(
    updated_definition,
    guard_anchor,
    'if session_user <> ''postgres'' or current_user <> ''postgres'' then'
  );
  updated_definition := pg_catalog.regexp_replace(
    updated_definition, security_definer_anchor, 'SECURITY INVOKER', 1, 0, 'i'
  );
  if position('p_secret' in updated_definition) > 0 then
    raise exception using errcode = 'P0001', message = 'student_import_management_replay_secret_parameter_remaining';
  end if;
  execute updated_definition;
end;
$student_import_management_replay_clone$;

revoke all on function internal.student_import_management_replay(
  text, bigint, text
) from public, anon, authenticated, service_role;
alter function internal.student_import_management_replay(
  text, bigint, text
) owner to postgres;

-- The clone must preserve the current final-write contracts.  These checks
-- make a later migration drift fail at deploy time instead of creating an
-- undocumented alternate import implementation.
do $student_import_management_contract_check$
declare
  source_definition text;
  commit_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_management_source_snapshot()'::pg_catalog.regprocedure
  ) into source_definition;
  select pg_catalog.pg_get_functiondef(
    'internal.student_import_management_commit(text,bigint,jsonb,jsonb,text)'::pg_catalog.regprocedure
  ) into commit_definition;
  if position('studentNumberReservations' in source_definition) = 0
     or position('formalImportDate' in commit_definition) = 0
     or position('student_import_assign_student_numbers' in commit_definition) = 0
     or position('student_import_identity_link_sets' in commit_definition) = 0
     or position('pg_advisory_xact_lock' in commit_definition) = 0
     or position('student_import_canonical_projection' in commit_definition) = 0
     or position('student_import_commits' in commit_definition) = 0
     or position('session_user' in commit_definition) = 0
     or position('session_user' in pg_catalog.pg_get_functiondef(
       'internal.student_import_management_replay(text,bigint,text)'::pg_catalog.regprocedure
     )) = 0 then
    raise exception using errcode = 'P0001', message = 'student_import_management_canonical_contract_missing';
  end if;
end;
$student_import_management_contract_check$;

-- Guard the release surface itself: all three helpers are invokers owned by
-- postgres and have no role-specific ACL entries beyond the owner.
do $student_import_management_acl_check$
declare
  function_row record;
begin
  for function_row in
    select p.oid, n.nspname, p.proname, p.prosecdef,
      owner_role.rolname as owner_name,
      coalesce(pg_catalog.array_to_string(p.proacl, E'\n'), '') as acl
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner_role on owner_role.oid = p.proowner
    where n.nspname = 'internal'
      and p.oid in (
        'internal.student_import_management_session()'::pg_catalog.regprocedure,
        'internal.student_import_management_source_snapshot()'::pg_catalog.regprocedure,
        'internal.student_import_management_snapshot()'::pg_catalog.regprocedure,
        'internal.student_import_management_commit(text,bigint,jsonb,jsonb,text)'::pg_catalog.regprocedure,
        'internal.student_import_management_replay(text,bigint,text)'::pg_catalog.regprocedure
      )
  loop
    if function_row.prosecdef
       or function_row.owner_name <> 'postgres'
       or function_row.acl ~ '(public|anon|authenticated|service_role)' then
      raise exception using errcode = 'P0001',
        message = 'student_import_management_acl_or_security_contract_mismatch';
    end if;
  end loop;
end;
$student_import_management_acl_check$;

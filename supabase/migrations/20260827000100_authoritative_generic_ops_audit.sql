-- Client-authored audit prose is not evidence. Wrap every generic ops_state
-- commit with an authoritative, server-derived audit row in the same database
-- transaction, and expose a secret-gated read projection for administrator UI.

alter function public.put_scoped_ops_state(text, text, jsonb, bigint, text, jsonb)
  rename to put_scoped_ops_state_without_authoritative_audit;

revoke all on function public.put_scoped_ops_state_without_authoritative_audit(text, text, jsonb, bigint, text, jsonb)
  from public, anon, authenticated;

create or replace function public.put_scoped_ops_state(
  p_secret text,
  p_entity text,
  p_payload jsonb,
  p_expected_version bigint,
  p_actor text,
  p_scope_versions jsonb default null
)
returns table (
  entity text,
  payload jsonb,
  version bigint,
  updated_at timestamptz,
  updated_by text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.ops_state%rowtype;
begin
  select committed.*
  into saved
  from public.put_scoped_ops_state_without_authoritative_audit(
    p_secret,
    p_entity,
    p_payload,
    p_expected_version,
    p_actor,
    p_scope_versions
  ) as committed;

  if not found then
    raise exception using errcode = 'P0002', message = 'ops_state_commit_missing';
  end if;

  perform internal.append_operational_contract_audit(
    'ops_state.' || saved.entity || '.updated',
    saved.updated_by,
    'ops_state',
    saved.entity,
    jsonb_build_object(
      'versionBefore', p_expected_version,
      'versionAfter', saved.version,
      'payloadSha256', encode(extensions.digest(p_payload::text, 'sha256'), 'hex')
    )
  );

  return query select saved.entity, saved.payload, saved.version, saved.updated_at, saved.updated_by;
end;
$$;

revoke all on function public.put_scoped_ops_state(text, text, jsonb, bigint, text, jsonb) from public;
grant execute on function public.put_scoped_ops_state(text, text, jsonb, bigint, text, jsonb) to anon, authenticated;

create or replace function public.read_operational_contract_audit(
  p_secret text,
  p_limit integer default 500
)
returns table (
  id uuid,
  action text,
  actor text,
  target_type text,
  target_id text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception 'invalid_ops_secret';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = '22023', message = 'invalid_audit_limit';
  end if;

  return query
  select audit.id, audit.action, audit.actor, audit.target_type, audit.target_id, audit.created_at
  from internal.operational_contract_audit as audit
  order by audit.created_at desc, audit.id desc
  limit p_limit;
end;
$$;

revoke all on function public.read_operational_contract_audit(text, integer) from public;
grant execute on function public.read_operational_contract_audit(text, integer) to anon, authenticated;

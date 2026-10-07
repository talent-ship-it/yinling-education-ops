\ir assert-disposable-database.sql
\set ON_ERROR_STOP on
create schema internal;
create schema extensions;
create extension pgcrypto with schema extensions;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
end $$;
create table public.ops_state (
  entity text primary key,
  payload jsonb not null,
  version bigint not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
create table internal.operational_contract_audit (
 id uuid primary key default extensions.gen_random_uuid(), action text not null, actor text not null,
 target_type text not null, target_id text not null, metadata jsonb not null, created_at timestamptz default now()
);
create table internal.student_import_source_rows (
 source_kind text primary key, source_id text, revision text, rows jsonb, row_count integer, rows_sha256 text
);
create table internal.student_import_identity_link_sets (singleton boolean, links jsonb, link_count integer, link_fingerprint text);
create function internal.student_import_source_key(value jsonb) returns text language sql immutable as $$
 select case when jsonb_typeof(value) in ('number','string') then value #>> '{}' end
$$;
do $$ begin
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
create function internal.verify_ops_secret(p_secret text)
returns boolean language sql stable as $$ select p_secret = 'synthetic-hour-secret' $$;
create function internal.append_operational_contract_audit(p_action text,p_actor text,p_target_type text,p_target_id text,p_metadata jsonb)
returns uuid language plpgsql as $$
declare id_value uuid;
begin
  insert into internal.operational_contract_audit(action,actor,target_type,target_id,metadata)
  values(p_action,p_actor,p_target_type,p_target_id,p_metadata) returning id into id_value;
  return id_value;
end;
$$;
create function public.put_scoped_ops_state_without_authoritative_audit(
  p_secret text,p_entity text,p_payload jsonb,p_expected_version bigint,p_actor text,p_scope_versions jsonb
)
returns table(entity text,payload jsonb,version bigint,updated_at timestamptz,updated_by text)
language plpgsql security definer set search_path = '' as $$
declare saved public.ops_state%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception 'invalid_ops_secret'; end if;
  update public.ops_state state set payload=p_payload,version=state.version+1,updated_at=clock_timestamp(),updated_by=p_actor
  where state.entity=p_entity and state.version=p_expected_version returning state.* into saved;
  if not found then raise exception using errcode='40001',message='version_conflict'; end if;
  return query select saved.entity,saved.payload,saved.version,saved.updated_at,saved.updated_by;
end;
$$;
revoke all on function public.put_scoped_ops_state_without_authoritative_audit(text,text,jsonb,bigint,text,jsonb) from public,anon,authenticated;

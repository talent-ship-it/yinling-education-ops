
create schema if not exists internal;
revoke all on schema internal from public, anon, authenticated;

create extension if not exists pgcrypto with schema extensions;

create table if not exists internal.ops_secrets (
  key text primary key,
  sha256_hex text not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

-- The production project already applied this historical migration. Keep the
-- schema in local history without committing credential-derived material;
-- fresh environments must provision the workspace digest out of band.

create table if not exists public.ops_state (
  entity text primary key,
  payload jsonb not null,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  updated_by text not null default 'system'
);

alter table public.ops_state enable row level security;
revoke all on table public.ops_state from public, anon, authenticated;
grant all on table public.ops_state to service_role;

create table if not exists public.ops_mutation_log (
  id bigint generated always as identity primary key,
  entity text not null,
  version bigint not null,
  actor text not null,
  changed_at timestamptz not null default now()
);

alter table public.ops_mutation_log enable row level security;
revoke all on table public.ops_mutation_log from public, anon, authenticated;
grant all on table public.ops_mutation_log to service_role;

create table if not exists public.ops_source_snapshots (
  source_id text primary key,
  title text not null,
  source_type text not null,
  url text,
  modified_at timestamptz,
  synced_at timestamptz not null default now(),
  row_count integer not null default 0,
  status text not null default 'read_only',
  payload jsonb not null default '{}'::jsonb
);

alter table public.ops_source_snapshots enable row level security;
revoke all on table public.ops_source_snapshots from public, anon, authenticated;
grant all on table public.ops_source_snapshots to service_role;

insert into public.ops_state(entity, payload, version, updated_by)
select
  entity,
  case
    when entity = 'meta' then (jsonb_agg(payload order by record_id)->0)
    else jsonb_agg(payload order by record_id)
  end,
  1,
  'initial_supabase_import'
from public.app_records
group by entity
on conflict (entity) do nothing;

insert into public.ops_state(entity, payload, version, updated_by) values
  ('tasks', '[]'::jsonb, 1, 'initial_defaults'),
  ('bookings', '[]'::jsonb, 1, 'initial_defaults'),
  ('lpItems', '[]'::jsonb, 1, 'initial_defaults'),
  ('operations', '[]'::jsonb, 1, 'initial_defaults'),
  ('renewals', '[]'::jsonb, 1, 'initial_defaults'),
  ('payroll', '[]'::jsonb, 1, 'initial_defaults'),
  ('messages', '[]'::jsonb, 1, 'initial_defaults'),
  ('files', '[]'::jsonb, 1, 'initial_defaults'),
  ('rules', '{"lpDays":"N-3","feedbackHours":"24","renewalDays":"8","escalation":"逾期 4 小时后通知主管","lowHours":"5","examDays":"30"}'::jsonb, 1, 'initial_defaults'),
  ('dataSnapshot', '{"label":"Supabase 多人共享真实资料","students":498,"teachers":216,"importedAt":"2026-07-22"}'::jsonb, 1, 'initial_defaults')
on conflict (entity) do nothing;

create or replace function internal.verify_ops_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from internal.ops_secrets s
    where s.key = 'workspace_api'
      and s.sha256_hex = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
  );
$$;

revoke all on function internal.verify_ops_secret(text) from public, anon, authenticated;

create or replace function public.get_ops_state(
  p_secret text,
  p_entities text[] default null
)
returns table (
  entity text,
  payload jsonb,
  version bigint,
  updated_at timestamptz,
  updated_by text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  return query
  select s.entity, s.payload, s.version, s.updated_at, s.updated_by
  from public.ops_state s
  where p_entities is null or s.entity = any(p_entities)
  order by s.entity;
end;
$$;

revoke all on function public.get_ops_state(text, text[]) from public;
grant execute on function public.get_ops_state(text, text[]) to anon;

create or replace function public.get_ops_sources(p_secret text)
returns table (
  source_id text,
  title text,
  source_type text,
  url text,
  modified_at timestamptz,
  synced_at timestamptz,
  row_count integer,
  status text,
  payload jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  return query
  select s.source_id, s.title, s.source_type, s.url, s.modified_at, s.synced_at, s.row_count, s.status, s.payload
  from public.ops_source_snapshots s
  order by s.synced_at desc, s.title;
end;
$$;

revoke all on function public.get_ops_sources(text) from public;
grant execute on function public.get_ops_sources(text) to anon;

create or replace function public.put_ops_state(
  p_secret text,
  p_entity text,
  p_payload jsonb,
  p_expected_version bigint,
  p_actor text
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
  current_row public.ops_state%rowtype;
  allowed_entities constant text[] := array[
    'students','teachers','tasks','bookings','lpItems','operations',
    'renewals','payroll','messages','files','audit','rules','dataSnapshot'
  ];
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;

  if not (p_entity = any(allowed_entities)) then
    raise exception using errcode = '22023', message = 'invalid_entity';
  end if;

  if p_payload is null then
    raise exception using errcode = '22004', message = 'payload_required';
  end if;

  select * into current_row
  from public.ops_state s
  where s.entity = p_entity
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'entity_not_found';
  end if;

  if p_expected_version is not null and current_row.version <> p_expected_version then
    raise exception using
      errcode = '40001',
      message = 'version_conflict',
      detail = current_row.version::text;
  end if;

  update public.ops_state s
  set payload = p_payload,
      version = s.version + 1,
      updated_at = now(),
      updated_by = left(coalesce(nullif(trim(p_actor), ''), 'unknown'), 80)
  where s.entity = p_entity
  returning s.* into current_row;

  insert into public.ops_mutation_log(entity, version, actor)
  values (current_row.entity, current_row.version, current_row.updated_by);

  return query
  select current_row.entity, current_row.payload, current_row.version, current_row.updated_at, current_row.updated_by;
end;
$$;

revoke all on function public.put_ops_state(text, text, jsonb, bigint, text) from public;
grant execute on function public.put_ops_state(text, text, jsonb, bigint, text) to anon;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ops_state'
  ) then
    alter publication supabase_realtime add table public.ops_state;
  end if;
end
$$;
;

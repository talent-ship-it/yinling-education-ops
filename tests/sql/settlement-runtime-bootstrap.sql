\set ON_ERROR_STOP on
\ir assert-disposable-database.sql

create table if not exists internal.ops_secrets (
  key text primary key,
  sha256_hex text not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

insert into internal.ops_secrets(key, sha256_hex)
values (
  'workspace_api',
  encode(extensions.digest('booking-projection-fixture-secret', 'sha256'), 'hex')
)
on conflict (key) do update set sha256_hex = excluded.sha256_hex, updated_at = now();

create or replace function internal.verify_ops_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from internal.ops_secrets
    where key = 'workspace_api'
      and sha256_hex = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
  );
$$;

revoke all on function internal.verify_ops_secret(text) from public, anon, authenticated;

create table if not exists public.app_records (
  entity text not null,
  record_id text not null,
  payload jsonb not null,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (entity, record_id)
);

alter table public.app_records enable row level security;

revoke all on table public.app_records from anon;
revoke all on table public.app_records from authenticated;

create index if not exists app_records_entity_idx on public.app_records (entity);
create index if not exists app_records_updated_at_idx on public.app_records (updated_at desc);

create or replace function public.set_app_records_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_app_records_updated_at on public.app_records;
create trigger set_app_records_updated_at
before update on public.app_records
for each row
execute function public.set_app_records_updated_at();;

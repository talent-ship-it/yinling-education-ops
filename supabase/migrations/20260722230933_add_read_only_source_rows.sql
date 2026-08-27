
create table if not exists public.ops_source_rows (
  source_id text not null references public.ops_source_snapshots(source_id) on delete cascade,
  row_number integer not null,
  payload jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (source_id, row_number)
);

alter table public.ops_source_rows enable row level security;
revoke all on public.ops_source_rows from public, anon, authenticated;

create index if not exists ops_source_rows_source_idx
  on public.ops_source_rows(source_id, row_number);
;

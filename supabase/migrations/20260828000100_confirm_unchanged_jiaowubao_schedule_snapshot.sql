-- A successful upstream pull is fresh evidence even when its immutable
-- revision is unchanged. Refresh only the current pointer's publication
-- timestamp after the server proves the expected revision still matches.

create or replace function public.confirm_jiaowubao_open_api_schedule_snapshot_current(
  p_secret text,
  p_api_source_key text,
  p_revision text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $confirm_jiaowubao_open_api_schedule_snapshot_current$
declare
  current_row internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
  confirmation_audit_id uuid;
  confirmed_at timestamptz;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_api_source_key <> 'jwb-open-api-schedule'
     or p_revision !~ '^sha256:[a-f0-9]{64}$'
     or p_actor <> 'Ops Admin' then
    raise exception using errcode = '42501', message = 'jiaowubao_open_api_schedule_snapshot_confirmation_forbidden';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jiaowubao-open-api-schedule:' || p_api_source_key, 0)
  );
  select * into current_row
  from internal.jiaowubao_open_api_schedule_snapshot_current current_pointer
  where current_pointer.api_source_key = p_api_source_key
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'jiaowubao_open_api_schedule_snapshot_current_not_found';
  end if;
  if current_row.revision is distinct from p_revision then
    raise exception using errcode = '55000', message = 'jiaowubao_open_api_schedule_snapshot_current_pointer_conflict';
  end if;

  confirmed_at := clock_timestamp();
  confirmation_audit_id := internal.append_operational_contract_audit(
    'jiaowubao_open_api_schedule_snapshot.confirmed_unchanged',
    p_actor,
    'jiaowubao_open_api_schedule_snapshot_ingest_run',
    current_row.run_id::text,
    jsonb_build_object(
      'apiSourceKey', current_row.api_source_key,
      'revision', current_row.revision,
      'rowCount', current_row.row_count,
      'confirmedAt', confirmed_at
    )
  );
  update internal.jiaowubao_open_api_schedule_snapshot_current
  set published_at = confirmed_at,
      audit_id = confirmation_audit_id
  where api_source_key = current_row.api_source_key;

  return jsonb_build_object(
    'confirmed', true,
    'revision', current_row.revision,
    'rowCount', current_row.row_count,
    'publishedAt', confirmed_at
  );
end;
$confirm_jiaowubao_open_api_schedule_snapshot_current$;

revoke all on function public.confirm_jiaowubao_open_api_schedule_snapshot_current(text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.confirm_jiaowubao_open_api_schedule_snapshot_current(text,text,text,text)
  to anon, authenticated;

comment on function public.confirm_jiaowubao_open_api_schedule_snapshot_current(text,text,text,text)
  is 'Server-only CAS heartbeat after a complete unchanged JWB source pull; refreshes freshness without duplicating immutable rows.';

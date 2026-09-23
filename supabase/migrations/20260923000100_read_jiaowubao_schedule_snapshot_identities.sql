-- Server-only, revision-pinned identity pagination for deletion-safe schedule
-- refreshes. Raw schedule payloads stay private; the cron receives only the
-- immutable source key and its untrusted source date.

create or replace function public.get_jiaowubao_open_api_schedule_snapshot_identity_page(
  p_secret text,
  p_api_source_key text,
  p_snapshot_revision text,
  p_limit integer default 500,
  p_cursor_source_key text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $get_jiaowubao_open_api_schedule_snapshot_identity_page$
declare
  current_row internal.jiaowubao_open_api_schedule_snapshot_current%rowtype;
  items jsonb;
  has_more boolean;
  next_cursor text;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_api_source_key <> 'jwb-open-api-schedule'
     or p_snapshot_revision is null
     or p_snapshot_revision !~ '^sha256:[a-f0-9]{64}$'
     or p_limit is null or p_limit not between 1 and 500
     or (p_cursor_source_key is not null and (
       p_cursor_source_key <> btrim(p_cursor_source_key)
       or p_cursor_source_key !~ '^jwb-open-api:schedule:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
     )) then
    raise exception using errcode = '22023', message = 'invalid_jiaowubao_schedule_identity_page_request';
  end if;

  select * into current_row
  from internal.jiaowubao_open_api_schedule_snapshot_current current_pointer
  where current_pointer.api_source_key = p_api_source_key;

  if not found then
    return jsonb_build_object(
      'state', 'absent', 'revision', null, 'rowCount', 0,
      'items', '[]'::jsonb, 'hasMore', false, 'nextCursor', null
    );
  end if;
  if current_row.revision <> p_snapshot_revision then
    return jsonb_build_object(
      'state', 'reset', 'revision', current_row.revision,
      'rowCount', current_row.row_count, 'items', '[]'::jsonb,
      'hasMore', false, 'nextCursor', null
    );
  end if;

  with page_plus_one as materialized (
    select snapshot_item.source_key,
      case
        when jsonb_typeof(snapshot_item.item -> 'record' -> 'dated') = 'string'
        then left(snapshot_item.item -> 'record' ->> 'dated', 64)
        else null
      end as source_date
    from internal.jiaowubao_open_api_schedule_snapshot_ingest_items snapshot_item
    where snapshot_item.run_id = current_row.run_id
      and (p_cursor_source_key is null
        or snapshot_item.source_key collate "C" > p_cursor_source_key collate "C")
    order by snapshot_item.source_key collate "C"
    limit p_limit + 1
  ), page_rows as materialized (
    select page_row.source_key, page_row.source_date
    from page_plus_one page_row
    order by page_row.source_key collate "C"
    limit p_limit
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
      'sourceKey', page_row.source_key,
      'sourceDate', page_row.source_date
    ) order by page_row.source_key collate "C") from page_rows page_row), '[]'::jsonb),
    (select count(*) > p_limit from page_plus_one),
    (select page_row.source_key from page_rows page_row
      order by page_row.source_key collate "C" desc limit 1)
  into items, has_more, next_cursor;

  return jsonb_build_object(
    'state', 'complete',
    'revision', current_row.revision,
    'rowCount', current_row.row_count,
    'items', items,
    'hasMore', has_more,
    'nextCursor', case when has_more then next_cursor else null end
  );
end;
$get_jiaowubao_open_api_schedule_snapshot_identity_page$;

-- The existing (run_id, source_key) key narrows this to the bounded current
-- snapshot before the C-collation sort. Avoid a blocking index build over the
-- unbounded historical ingest table during a production migration.

revoke all on function public.get_jiaowubao_open_api_schedule_snapshot_identity_page(
  text, text, text, integer, text
) from public, anon, authenticated;
-- Server Ops RPCs intentionally enter PostgREST with the publishable role;
-- the unexposed OPS secret is the second factor checked before any row read.
grant execute on function public.get_jiaowubao_open_api_schedule_snapshot_identity_page(
  text, text, text, integer, text
) to anon, authenticated;

comment on function public.get_jiaowubao_open_api_schedule_snapshot_identity_page(
  text, text, text, integer, text
) is 'Secret-gated, revision-pinned identity-only reader used to require two complete observations before removing current schedule rows.';

\set ON_ERROR_STOP on
\ir assert-disposable-database.sql
begin;
set local statement_timeout = '2s';

do $optimized$
declare started timestamptz; helper_ms double precision; reader_ms double precision;
  actual jsonb; page jsonb; ids text[]; baseline internal.fixture_wecom_repost_performance_baseline%rowtype;
  cursor_value text; seen text[] := array[]::text[]; next_ids text[];
begin
  select * into strict baseline from internal.fixture_wecom_repost_performance_baseline;
  started := clock_timestamp();
  select jsonb_object_agg(message_id,internal.wecom_lp_superseded_by(message_id)) into actual
  from internal.wecom_archive_messages where chat_id='repost-scale-room';
  helper_ms := extract(epoch from clock_timestamp()-started)*1000;
  if actual <> baseline.superseded then raise exception 'repost_scale_superseded_results_changed'; end if;
  started := clock_timestamp();
  page := public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',true,null,30,'2101-01-01','2101-01-05');
  reader_ms := extract(epoch from clock_timestamp()-started)*1000;
  select array_agg(row->>'sourceMessageId' order by row->>'sourceMessageId') into ids from jsonb_array_elements(page->'rows') row;
  if (page->>'total')::bigint <> baseline.total or ids <> baseline.page_ids then
    raise exception 'repost_scale_reader_results_changed';
  end if;
  loop
    select coalesce(array_agg(row->>'sourceMessageId'),array[]::text[]) into next_ids from jsonb_array_elements(page->'rows') row;
    seen := seen || next_ids;
    cursor_value := page->>'nextCursor';
    exit when cursor_value is null;
    page := public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',true,cursor_value,30,'2101-01-01','2101-01-05');
    if (page->>'total')::bigint <> baseline.total then raise exception 'repost_scale_total_changed_between_pages'; end if;
  end loop;
  if cardinality(seen) <> baseline.total or (select count(distinct id) from unnest(seen) id) <> baseline.total
    or exists(select 1 from unnest(seen) id where actual->>id is not null) then
    raise exception 'repost_scale_pagination_dropped_or_repeated';
  end if;
  if (public.read_wecom_lp_drafts_in_range('wecom-fixture-secret','Abby',true,null,30,'2101-01-01','2101-01-01 00:03'))->>'total' <> '0' then
    raise exception 'repost_scale_range_resurrected_old_sources';
  end if;
  if exists(select 1 from pg_catalog.pg_proc
    where oid='internal.wecom_lp_superseded_by(text)'::regprocedure
      and (proowner <> baseline.helper_owner or proacl is distinct from baseline.helper_acl or prosecdef <> baseline.helper_security)) then
    raise exception 'repost_scale_helper_privileges_changed';
  end if;
  if helper_ms >= baseline.helper_ms * 0.5 + 20 or reader_ms >= baseline.reader_ms * 0.5 + 20 then
    raise exception 'repost_scale_performance_did_not_improve: helper % -> %, reader % -> %',
      baseline.helper_ms,helper_ms,baseline.reader_ms,reader_ms;
  end if;
  raise notice 'repost_scale_optimized: rows=101 cases=96 kept=% helper_ms=% -> % reader_ms=% -> %',
    baseline.total,baseline.helper_ms,helper_ms,baseline.reader_ms,reader_ms;
end;
$optimized$;
select 'wecom_lp_repost_performance_runtime_ok' as result;
rollback;

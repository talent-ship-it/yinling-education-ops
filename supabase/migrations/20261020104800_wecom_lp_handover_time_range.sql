create function public.read_wecom_lp_drafts_in_range(
  p_secret text, p_actor text, p_full_admin boolean,
  p_cursor text default null, p_limit integer default 30,
  p_from timestamptz default null, p_before timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare cursor_at timestamptz; result_rows jsonb; more boolean; total_count bigint;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if nullif(btrim(p_actor), '') is null or length(p_actor) > 120 or p_full_admin is null
     or p_limit is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'invalid_wecom_lp_scope';
  end if;
  if (p_from is not null and not pg_catalog.isfinite(p_from))
     or (p_before is not null and not pg_catalog.isfinite(p_before))
     or (p_from is not null and p_before is not null and p_from >= p_before) then
    raise exception using errcode = '22023', message = 'invalid_wecom_lp_range';
  end if;
  if p_cursor is not null then
    select m.sent_at into cursor_at
    from internal.wecom_archive_messages m
    join internal.wecom_trial_handover_cases c on c.id = m.trial_handover_id
    where m.message_id = p_cursor
      and m.ingested_by = 'WeCom Bot Receiver' and m.message_type = 'text'
      and m.classification = 'handover' and internal.wecom_is_lp_template(m.body)
      and (p_full_admin or coalesce(m.operations_owner_hint, c.operations_owner) = btrim(p_actor))
      and (p_from is null or m.sent_at >= p_from)
      and (p_before is null or m.sent_at < p_before);
    if not found then raise exception using errcode = '22023', message = 'invalid_wecom_lp_cursor'; end if;
  end if;
  with eligible as materialized (
    select m.message_id, m.sent_at
    from internal.wecom_archive_messages m
    join internal.wecom_trial_handover_cases c on c.id = m.trial_handover_id
    where m.ingested_by = 'WeCom Bot Receiver' and m.message_type = 'text'
      and m.classification = 'handover' and internal.wecom_is_lp_template(m.body)
      and (p_full_admin or coalesce(m.operations_owner_hint, c.operations_owner) = btrim(p_actor))
      and (p_from is null or m.sent_at >= p_from)
      and (p_before is null or m.sent_at < p_before)
  ), page as (
    select * from eligible
    where p_cursor is null or (sent_at, message_id) > (cursor_at, p_cursor)
    order by sent_at, message_id limit p_limit + 1
  ), numbered as (
    select *, row_number() over (order by sent_at, message_id) as position from page
  )
  select coalesce(jsonb_agg(internal.wecom_lp_draft_source(message_id)
        || jsonb_build_object('handoverAt', sent_at) order by sent_at, message_id)
      filter (where position <= p_limit), '[]'::jsonb), count(*) > p_limit, (select count(*) from eligible)
  into result_rows, more, total_count from numbered;
  return jsonb_build_object('rows', result_rows, 'total', total_count,
    'nextCursor', case when more then result_rows -> (jsonb_array_length(result_rows) - 1) ->> 'sourceMessageId' else null end);
end;
$$;
revoke all on function public.read_wecom_lp_drafts_in_range(text,text,boolean,text,integer,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.read_wecom_lp_drafts_in_range(text,text,boolean,text,integer,timestamptz,timestamptz)
  to anon, authenticated;

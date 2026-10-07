set local lock_timeout = '2s';

do $narrow_schedule_reader$
declare
  target_oid regprocedure := 'public.get_jiaowubao_open_api_schedule_snapshot_window(text,timestamptz,timestamptz,text,text[],text[],integer,timestamptz,text,text,text[])'::regprocedure;
  definition text := pg_catalog.pg_get_functiondef(target_oid);
  boundary text := '  if p_cursor_start is null and p_scope <> ''availability'' then';
  query_prefix text;
  query_suffix text;
  anchor text;
  replacement text;
begin
  if position(boundary in definition) = 0
     or position(boundary in substr(definition, position(boundary in definition) + char_length(boundary))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_reader_boundary_mismatch';
  end if;
  query_prefix := substr(definition, 1, position(boundary in definition) - 1);
  query_suffix := substr(definition, position(boundary in definition));
  anchor := 'with snapshot_items as materialized (';
  if position(anchor in query_prefix) = 0
     or position(anchor in substr(query_prefix, position(anchor in query_prefix) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_reader_source_anchor_mismatch';
  end if;
  query_prefix := replace(query_prefix, anchor, 'with snapshot_items as not materialized (');
  anchor := $anchor$      snapshot_item.record,
$anchor$;
  replacement := $replacement$      case when p_scope = 'student' then snapshot_item.record -> 'stu_list'
        else '[]'::jsonb end as scope_students,
$replacement$;
  if position(anchor in query_prefix) = 0
     or position(anchor in substr(query_prefix, position(anchor in query_prefix) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_reader_fields_anchor_mismatch';
  end if;
  query_prefix := replace(query_prefix, anchor, replacement);
  anchor := 'parsed_event.record -> ''stu_list''';
  if (char_length(query_prefix) - char_length(replace(query_prefix, anchor, ''))) / char_length(anchor) <> 2 then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_reader_scope_anchor_mismatch';
  end if;
  query_prefix := replace(query_prefix, anchor, 'parsed_event.scope_students');
  anchor := $anchor$    select page_event.*
    from page_plus_one page_event
    order by page_event.starts_at, page_event.event_id
    limit p_limit
$anchor$;
  replacement := $replacement$    select page_event.*, page_source.item -> 'record' as record
    from page_plus_one page_event
    join internal.jiaowubao_open_api_schedule_snapshot_ingest_items page_source
      on page_source.run_id = current_row.run_id
      and page_source.source_key = page_event.event_id
    order by page_event.starts_at, page_event.event_id
    limit p_limit
$replacement$;
  if position(anchor in query_prefix) = 0
     or position(anchor in substr(query_prefix, position(anchor in query_prefix) + char_length(anchor))) <> 0 then
    raise exception using errcode = '55000', message = 'jiaowubao_schedule_reader_page_anchor_mismatch';
  end if;
  execute replace(query_prefix, anchor, replacement) || query_suffix;
end;
$narrow_schedule_reader$;

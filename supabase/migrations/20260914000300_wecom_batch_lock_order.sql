-- Acquire the whole batch's locks before projecting its first message. Numeric
-- hash order is shared by archive and bot ingestion, including hash collisions.
create or replace function internal.lock_wecom_batch_messages(p_records jsonb)
returns void language plpgsql security definer set search_path = '' as $function$
declare lock_key bigint;
begin
  for lock_key in
    select distinct pg_catalog.hashtextextended(item ->> 'messageId', 0)
    from pg_catalog.jsonb_array_elements(p_records) item
    where pg_catalog.jsonb_typeof(item -> 'messageId') = 'string'
    order by 1
  loop
    perform pg_catalog.pg_advisory_xact_lock(lock_key);
  end loop;
  -- Manual linking locks archive rows before shared state too. Lock all
  -- existing rows now so a later record cannot invert that order.
  perform 1 from internal.wecom_archive_messages archived
  where archived.message_id in (
    select item ->> 'messageId' from pg_catalog.jsonb_array_elements(p_records) item
  )
  order by archived.message_id
  for update;
end;
$function$;
revoke all on function internal.lock_wecom_batch_messages(jsonb) from public, anon, authenticated, service_role;

do $batch_lock_order$
declare target record; definition text;
begin
  for target in select * from (values
    ('public.ingest_wecom_archive_batch(text,jsonb,timestamp with time zone,text)',
     '  for source in select value from jsonb_array_elements(p_records)'),
    ('public.ingest_wecom_bot_batch(text,jsonb,timestamp with time zone,text)',
     '  for source in select value from pg_catalog.jsonb_array_elements(p_records)')
  ) as targets(signature, loop_start) loop
    definition := pg_get_functiondef(target.signature::regprocedure);
    if position('perform internal.lock_wecom_batch_messages(p_records);' in definition) > 0 then continue; end if;
    if (length(definition) - length(replace(definition, target.loop_start, ''))) / length(target.loop_start) <> 1 then
      raise exception 'wecom_batch_definition_drift: %', target.signature;
    end if;
    -- The insertion point follows the existing secret and batch size checks.
    execute replace(definition, target.loop_start,
      E'  perform internal.lock_wecom_batch_messages(p_records);\n\n' || target.loop_start);
  end loop;
end;
$batch_lock_order$;

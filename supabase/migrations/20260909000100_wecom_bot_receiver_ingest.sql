-- Bot callbacks are a separate, review-only ingress path.  They do not have
-- the authenticated conversation-archive context required for automatic
-- student matching, so they are always stored as pending `other` records.

create or replace function public.ingest_wecom_bot_batch(
  p_secret text,
  p_records jsonb,
  p_started_at timestamptz,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source jsonb;
  existing internal.wecom_archive_messages%rowtype;
  canonical_record jsonb;
  canonical_body text;
  record_hash text;
  inserted_count integer := 0;
  duplicate_count integer := 0;
  canonical_actor text := left(coalesce(nullif(pg_catalog.btrim(p_actor), ''), 'WeCom Bot Receiver'), 120);
  message_type text;
  sent_at timestamptz;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_started_at is null or p_started_at > pg_catalog.now() + interval '5 minutes'
     or pg_catalog.jsonb_typeof(p_records) <> 'array'
     or pg_catalog.jsonb_array_length(p_records) < 1
     or pg_catalog.jsonb_array_length(p_records) > 50
     or pg_catalog.octet_length(p_records::text) > 8388608 then
    raise exception using errcode = '22023', message = 'invalid_wecom_bot_batch';
  end if;

  for source in select value from pg_catalog.jsonb_array_elements(p_records)
  loop
    if pg_catalog.jsonb_typeof(source) <> 'object'
       or source - 'messageId' - 'chatId' - 'senderId' - 'sentAt' - 'messageType' - 'text' <> '{}'::jsonb
       or coalesce(source ->> 'messageId', '') !~ '^bot:[a-f0-9]{64}$'
       or nullif(pg_catalog.btrim(source ->> 'chatId'), '') is null
       or pg_catalog.length(source ->> 'chatId') > 240
       or nullif(pg_catalog.btrim(source ->> 'senderId'), '') is null
       or pg_catalog.length(source ->> 'senderId') > 240
       or coalesce(source ->> 'messageType', '') not in ('text', 'image', 'file', 'mixed', 'other')
       or nullif(pg_catalog.btrim(source ->> 'sentAt'), '') is null
       or (source ? 'text' and source -> 'text' is not null and pg_catalog.jsonb_typeof(source -> 'text') <> 'string')
       or pg_catalog.length(coalesce(source ->> 'text', '')) > 12000 then
      raise exception using errcode = '22023', message = 'invalid_wecom_bot_record';
    end if;

    begin
      sent_at := (source ->> 'sentAt')::timestamptz;
      if sent_at < p_started_at or sent_at > pg_catalog.now() + interval '5 minutes' then
        raise exception using errcode = '22023', message = 'wecom_bot_record_outside_window';
      end if;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'invalid_wecom_bot_timestamp';
    end;

    canonical_body := nullif(pg_catalog.btrim(coalesce(source ->> 'text', '')), '');
    message_type := case when source ->> 'messageType' = 'text' then 'text' else 'other' end;
    canonical_record := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'messageId', source ->> 'messageId',
      'chatId', pg_catalog.btrim(source ->> 'chatId'),
      'senderId', pg_catalog.btrim(source ->> 'senderId'),
      'sentAt', sent_at,
      'messageType', message_type,
      'text', canonical_body
    ));
    record_hash := encode(extensions.digest(canonical_record::text, 'sha256'), 'hex');

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(source ->> 'messageId', 0)
    );
    select * into existing from internal.wecom_archive_messages item
    where item.message_id = source ->> 'messageId'
    for update;
    if existing.message_id is not null then
      if existing.content_sha256 <> record_hash then
        raise exception using errcode = '23505', message = 'wecom_bot_idempotency_conflict';
      end if;
      duplicate_count := duplicate_count + 1;
      continue;
    end if;

    insert into internal.wecom_archive_messages (
      message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
      body, classification, student_name_hint, guardian_wechat_hint,
      student_id, match_status, ingested_by
    ) values (
      source ->> 'messageId', record_hash, pg_catalog.btrim(source ->> 'chatId'),
      pg_catalog.btrim(source ->> 'senderId'), sent_at, message_type, canonical_body,
      'other', null, null, null, 'pending', canonical_actor
    );
    inserted_count := inserted_count + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'inserted', inserted_count,
    'duplicates', duplicate_count,
    'pending', inserted_count
  );
end;
$$;

revoke all on function public.ingest_wecom_bot_batch(text, jsonb, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.ingest_wecom_bot_batch(text, jsonb, timestamptz, text)
  to anon;

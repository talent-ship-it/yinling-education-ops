-- Text callbacks from the receive-only bot can use the same deterministic
-- classification and explicit-name hints as the authenticated archive worker.
-- They remain review-only: this function never projects ordinary business
-- state.  The promotion branch upgrades an older pending bot row in place when
-- a previously received callback is replayed after this contract is deployed.

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
  canonical_classification text;
  canonical_student_hint text;
  canonical_guardian_hint text;
  record_hash text;
  inserted_count integer := 0;
  duplicate_count integer := 0;
  promoted_count integer := 0;
  pending_count integer := 0;
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
       or source - 'messageId' - 'chatId' - 'senderId' - 'sentAt' - 'messageType' - 'text'
         - 'classification' - 'studentNameHint' - 'guardianWechatHint' <> '{}'::jsonb
       or coalesce(source ->> 'messageId', '') !~ '^bot:[a-f0-9]{64}$'
       or nullif(pg_catalog.btrim(source ->> 'chatId'), '') is null
       or pg_catalog.length(source ->> 'chatId') > 240
       or nullif(pg_catalog.btrim(source ->> 'senderId'), '') is null
       or pg_catalog.length(source ->> 'senderId') > 240
       or coalesce(source ->> 'messageType', '') not in ('text', 'image', 'file', 'mixed', 'other')
       or nullif(pg_catalog.btrim(source ->> 'sentAt'), '') is null
       or (source ? 'text' and source -> 'text' is not null and pg_catalog.jsonb_typeof(source -> 'text') <> 'string')
       or (source ? 'classification' and (
         pg_catalog.jsonb_typeof(source -> 'classification') <> 'string'
         or coalesce(pg_catalog.btrim(source ->> 'classification'), '') not in
           ('handover', 'renewal_follow_up', 'trial_scheduling', 'other')
       ))
       or (source ? 'studentNameHint' and source -> 'studentNameHint' is not null
         and pg_catalog.jsonb_typeof(source -> 'studentNameHint') <> 'string')
       or (source ? 'guardianWechatHint' and source -> 'guardianWechatHint' is not null
         and pg_catalog.jsonb_typeof(source -> 'guardianWechatHint') <> 'string')
       or pg_catalog.length(coalesce(source ->> 'text', '')) > 12000
       or pg_catalog.length(coalesce(source ->> 'studentNameHint', '')) > 240
       or pg_catalog.length(coalesce(source ->> 'guardianWechatHint', '')) > 240 then
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

    message_type := case when source ->> 'messageType' = 'text' then 'text' else 'other' end;
    canonical_classification := coalesce(nullif(pg_catalog.btrim(source ->> 'classification'), ''), 'other');
    canonical_student_hint := nullif(pg_catalog.btrim(coalesce(source ->> 'studentNameHint', '')), '');
    canonical_guardian_hint := nullif(pg_catalog.btrim(coalesce(source ->> 'guardianWechatHint', '')), '');
    if message_type <> 'text' and (
      canonical_classification <> 'other'
      or canonical_student_hint is not null
      or canonical_guardian_hint is not null
    ) then
      raise exception using errcode = '22023', message = 'invalid_wecom_bot_metadata';
    end if;

    canonical_body := case when message_type = 'text'
      then nullif(pg_catalog.btrim(coalesce(source ->> 'text', '')), '')
      else null
    end;
    canonical_record := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'messageId', source ->> 'messageId',
      'chatId', pg_catalog.btrim(source ->> 'chatId'),
      'senderId', pg_catalog.btrim(source ->> 'senderId'),
      'sentAt', sent_at,
      'messageType', message_type,
      'text', canonical_body,
      'classification', canonical_classification,
      'studentNameHint', canonical_student_hint,
      'guardianWechatHint', canonical_guardian_hint
    ));
    record_hash := encode(extensions.digest(canonical_record::text, 'sha256'), 'hex');

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(source ->> 'messageId', 0)
    );
    select * into existing from internal.wecom_archive_messages item
    where item.message_id = source ->> 'messageId'
    for update;
    if existing.message_id is not null then
      if existing.content_sha256 = record_hash then
        duplicate_count := duplicate_count + 1;
        continue;
      end if;

      -- A callback may have reached Supabase before the classifier was added.
      -- Upgrade only an untouched, pending text row with identical source
      -- evidence; never overwrite a human decision or an attached file.
      if canonical_classification <> 'other'
         and existing.classification = 'other'
         and existing.match_status = 'pending'
         and existing.student_id is null
         and existing.projected_at is null
         and existing.student_name_hint is null
         and existing.guardian_wechat_hint is null
         and existing.message_type = message_type
         and existing.chat_id = pg_catalog.btrim(source ->> 'chatId')
         and existing.sender_id = pg_catalog.btrim(source ->> 'senderId')
         and existing.sent_at = sent_at
         and existing.body is not distinct from canonical_body
         and not exists (
           select 1 from internal.wecom_archive_media media
           where media.message_id = existing.message_id
         ) then
        update internal.wecom_archive_messages
        set content_sha256 = record_hash,
            classification = canonical_classification,
            student_name_hint = canonical_student_hint,
            guardian_wechat_hint = canonical_guardian_hint,
            updated_at = pg_catalog.now()
        where message_id = existing.message_id;
        promoted_count := promoted_count + 1;
        pending_count := pending_count + 1;
        continue;
      end if;

      raise exception using errcode = '23505', message = 'wecom_bot_idempotency_conflict';
    end if;

    insert into internal.wecom_archive_messages (
      message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
      body, classification, student_name_hint, guardian_wechat_hint,
      student_id, match_status, ingested_by
    ) values (
      source ->> 'messageId', record_hash, pg_catalog.btrim(source ->> 'chatId'),
      pg_catalog.btrim(source ->> 'senderId'), sent_at, message_type, canonical_body,
      canonical_classification, canonical_student_hint, canonical_guardian_hint,
      null, 'pending', canonical_actor
    );
    inserted_count := inserted_count + 1;
    pending_count := pending_count + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'inserted', inserted_count,
    'duplicates', duplicate_count,
    'promoted', promoted_count,
    'pending', pending_count
  );
end;
$$;

revoke all on function public.ingest_wecom_bot_batch(text, jsonb, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.ingest_wecom_bot_batch(text, jsonb, timestamptz, text)
  to anon;

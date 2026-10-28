create or replace function internal.wecom_lp_superseded_by(p_message_id text)
returns text language plpgsql stable security invoker set search_path = '' as $$
declare source internal.wecom_archive_messages%rowtype; source_key text[]; latest_id text;
begin
  if exists(select 1 from internal.wecom_lp_confirmations c where c.source_message_id = p_message_id) then return null; end if;
  select * into source from internal.wecom_archive_messages where message_id = p_message_id;
  if not found then return null; end if;
  source_key := internal.wecom_lp_repost_key(source);
  if source_key is null then return null; end if;
  with candidates as materialized (
    select m as candidate from internal.wecom_archive_messages m
    where m.chat_id = source.chat_id and m.ingested_by = 'WeCom Bot Receiver'
      and m.message_type = 'text' and m.classification = 'handover'
      and (m.sent_at, m.message_id) > (source.sent_at, source.message_id)
      and m.trial_handover_id is not distinct from source.trial_handover_id
  )
  select (candidate).message_id into latest_id from candidates
  where internal.wecom_lp_repost_key(candidate) = source_key
  order by (candidate).sent_at desc, (candidate).message_id desc limit 1;
  return latest_id;
end;
$$;

create table internal.wecom_bot_quoted_identities (
  message_id text primary key references internal.wecom_archive_messages(message_id) on delete restrict,
  quote jsonb not null check (jsonb_typeof(quote) = 'object'),
  student_name text check (length(student_name) between 2 and 80),
  source_message_id text references internal.wecom_archive_messages(message_id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'matched', 'conflict', 'ambiguous')),
  created_at timestamptz not null default now()
);
alter table internal.wecom_bot_quoted_identities enable row level security;
revoke all on table internal.wecom_bot_quoted_identities from public, anon, authenticated, service_role;
create index wecom_bot_quoted_pending_idx on internal.wecom_bot_quoted_identities(message_id) where status = 'pending';

create function internal.resolve_wecom_quoted_identity(p_message_id text, p_started_at timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  evidence internal.wecom_bot_quoted_identities%rowtype;
  reply internal.wecom_archive_messages%rowtype;
  original internal.wecom_archive_messages%rowtype;
  handover internal.wecom_trial_handover_cases%rowtype;
  candidates text[];
  candidate_count integer;
  result_status text := 'pending';
begin
  select * into evidence from internal.wecom_bot_quoted_identities where message_id = p_message_id;
  if not found or evidence.status <> 'pending' or evidence.student_name is null then return; end if;
  select * into reply from internal.wecom_archive_messages where message_id = p_message_id;
  if reply.ingested_by <> 'WeCom Bot Receiver' or reply.message_type <> 'text'
     or reply.sent_at < p_started_at or reply.student_id is not null or reply.projected_at is not null then return; end if;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(reply.chat_id, 0)) then return; end if;

  select array_agg(m.message_id order by m.message_id) into candidates
  from internal.wecom_archive_messages m
  where m.chat_id = reply.chat_id and m.ingested_by = 'WeCom Bot Receiver'
    and m.message_type = 'text' and m.classification = 'handover'
    and m.trial_handover_id is not null and internal.wecom_is_trial_lp_template(m.body)
    and m.sent_at >= p_started_at and m.sent_at <= reply.sent_at and m.message_id <> reply.message_id
    and case when evidence.quote ? 'messageId' then m.message_id = evidence.quote ->> 'messageId'
      else evidence.quote ? 'text' and m.body = evidence.quote ->> 'text' end
    and (not (evidence.quote ? 'text') or m.body = evidence.quote ->> 'text');
  candidate_count := coalesce(cardinality(candidates), 0);
  if candidate_count > 1 then
    update internal.wecom_bot_quoted_identities set status = 'ambiguous' where message_id = p_message_id;
    return;
  end if;
  if candidate_count <> 1 then return; end if;

  begin
    select * into original from internal.wecom_archive_messages where message_id = candidates[1] for share nowait;
    if not found or original.chat_id <> reply.chat_id or original.ingested_by <> 'WeCom Bot Receiver'
      or original.message_type <> 'text' or original.classification <> 'handover'
      or not coalesce(internal.wecom_is_trial_lp_template(original.body), false)
      or original.sent_at < p_started_at or original.sent_at > reply.sent_at
      or (evidence.quote ? 'text' and original.body is distinct from evidence.quote ->> 'text') then return; end if;
    select * into handover from internal.wecom_trial_handover_cases where id = original.trial_handover_id for update nowait;
    if not found then return; end if;
    if handover.chat_id <> reply.chat_id or handover.status in ('identity_conflict', 'identity_ambiguous')
      or (reply.trial_handover_id is not null and reply.trial_handover_id <> handover.id) then
      result_status := 'conflict';
    elsif (original.student_name_hint is not null and internal.wecom_name_key(original.student_name_hint) <> internal.wecom_name_key(evidence.student_name))
      or (handover.student_name is not null and internal.wecom_name_key(handover.student_name) <> internal.wecom_name_key(evidence.student_name)) then
      result_status := 'conflict';
    elsif exists (select 1 from internal.wecom_lp_confirmations c where c.source_message_id = original.message_id)
      and handover.student_name is null then
      result_status := 'conflict';
    else
      select count(*) into candidate_count from public.ops_state s cross join lateral jsonb_array_elements(s.payload) student
      where s.entity = 'students' and coalesce(student ->> 'importArchived', 'false') <> 'true'
        and internal.wecom_name_key(student ->> 'name') = internal.wecom_name_key(evidence.student_name);
      if candidate_count > 1 or (handover.student_name is null and (
        select count(*) from internal.wecom_archive_messages m
        where m.trial_handover_id = handover.id and m.classification = 'handover'
          and m.ingested_by = 'WeCom Bot Receiver' and internal.wecom_is_trial_lp_template(m.body)
      ) > 1) then
        result_status := 'ambiguous';
      else
        result_status := 'matched';
        update internal.wecom_trial_handover_cases
        set student_name = coalesce(student_name, evidence.student_name), status = 'identified',
          identity_message_id = coalesce(identity_message_id, reply.message_id), updated_at = now()
        where id = handover.id and (student_name is null or status <> 'identified' or identity_message_id is null);
        update internal.wecom_archive_messages
        set trial_handover_id = handover.id, student_name_hint = evidence.student_name, updated_at = now()
        where message_id = reply.message_id and trial_handover_id is null;
      end if;
    end if;
    update internal.wecom_bot_quoted_identities set status = result_status, source_message_id = original.message_id
    where message_id = p_message_id;
    perform internal.append_operational_contract_audit('wecom.bot.quoted_identity', 'WeCom Bot Receiver', 'wecom_message',
      reply.message_id, jsonb_build_object('sourceMessageId', original.message_id, 'status', result_status));
  exception when lock_not_available then return;
  end;
end;
$$;
revoke all on function internal.resolve_wecom_quoted_identity(text,timestamptz) from public, anon, authenticated, service_role;

alter function public.ingest_wecom_bot_batch(text,jsonb,timestamptz,text) set schema internal;
alter function internal.ingest_wecom_bot_batch(text,jsonb,timestamptz,text) rename to ingest_wecom_bot_batch_without_quotes;
revoke all on function internal.ingest_wecom_bot_batch_without_quotes(text,jsonb,timestamptz,text) from public, anon, authenticated, service_role;

create function public.ingest_wecom_bot_batch(p_secret text, p_records jsonb, p_started_at timestamptz, p_actor text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  source jsonb;
  stripped jsonb;
  result jsonb;
  prior internal.wecom_bot_quoted_identities%rowtype;
  pending_id text;
begin
  if not internal.verify_ops_secret(p_secret) then raise exception using errcode = '42501', message = 'invalid_ops_secret'; end if;
  if p_started_at is null
     or jsonb_typeof(p_records) is distinct from 'array'
     or jsonb_array_length(p_records) not between 1 and 50 or octet_length(p_records::text) > 8388608 then
    raise exception using errcode = '22023', message = 'invalid_wecom_bot_batch';
  end if;
  for source in select value from jsonb_array_elements(p_records) loop
    if source ? 'quotedStudentName' and not (source ? 'quote') then
      raise exception using errcode = '22023', message = 'invalid_wecom_bot_quote';
    end if;
    if source ? 'quote' and (
      jsonb_typeof(source -> 'quote') is distinct from 'object'
      or (source -> 'quote') - 'messageId' - 'text' <> '{}'::jsonb
      or source ->> 'messageType' is distinct from 'text'
      or coalesce(source ->> 'classification', 'other') <> 'other'
      or source ?| array['studentNameHint', 'guardianWechatHint', 'operationsOwnerHint', 'coursePlannerHint']
      or ((source -> 'quote') ? 'messageId' and (
        jsonb_typeof(source #> '{quote,messageId}') is distinct from 'string'
        or coalesce(source #>> '{quote,messageId}', '') !~ '^bot:[a-f0-9]{64}$'
        or source #>> '{quote,messageId}' = source ->> 'messageId'))
      or ((source -> 'quote') ? 'text' and (jsonb_typeof(source #> '{quote,text}') is distinct from 'string'
        or length(source #>> '{quote,text}') not between 1 and 12000))
      or (source ? 'quotedStudentName' and (jsonb_typeof(source -> 'quotedStudentName') is distinct from 'string'
        or length(source ->> 'quotedStudentName') not between 2 and 80
        or source ->> 'quotedStudentName' ~ E'[\\n\\r]'))
    ) then raise exception using errcode = '22023', message = 'invalid_wecom_bot_quote'; end if;
  end loop;
  select jsonb_agg(value - 'quote' - 'quotedStudentName' order by ordinality) into stripped
  from jsonb_array_elements(p_records) with ordinality;
  result := internal.ingest_wecom_bot_batch_without_quotes(p_secret, stripped, p_started_at, p_actor);
  for source in select value from jsonb_array_elements(p_records) loop
    select * into prior from internal.wecom_bot_quoted_identities where message_id = source ->> 'messageId' for update;
    if found then
      if not (source ? 'quote') or prior.quote is distinct from source -> 'quote'
        or prior.student_name is distinct from source ->> 'quotedStudentName' then
        raise exception using errcode = '23505', message = 'wecom_bot_quote_idempotency_conflict';
      end if;
    elsif source ? 'quote' then
      insert into internal.wecom_bot_quoted_identities(message_id, quote, student_name)
      values (source ->> 'messageId', source -> 'quote', source ->> 'quotedStudentName');
    end if;
  end loop;
  for pending_id in
    select q.message_id from internal.wecom_bot_quoted_identities q
    join internal.wecom_archive_messages m on m.message_id = q.message_id
    where q.status = 'pending' and q.student_name is not null
      and m.ingested_by = 'WeCom Bot Receiver' and m.message_type = 'text'
      and m.sent_at >= p_started_at and m.student_id is null and m.projected_at is null
      and m.chat_id in (select value ->> 'chatId' from jsonb_array_elements(p_records))
      and exists (
        select 1 from internal.wecom_archive_messages original
        where original.chat_id = m.chat_id and original.ingested_by = 'WeCom Bot Receiver'
          and original.message_type = 'text' and original.classification = 'handover'
          and original.trial_handover_id is not null and internal.wecom_is_trial_lp_template(original.body)
          and original.sent_at >= p_started_at and original.sent_at <= m.sent_at and original.message_id <> m.message_id
          and case when q.quote ? 'messageId' then original.message_id = q.quote ->> 'messageId'
            else q.quote ? 'text' and original.body = q.quote ->> 'text' end
          and (not (q.quote ? 'text') or original.body = q.quote ->> 'text')
      )
    order by (q.message_id in (select value ->> 'messageId' from jsonb_array_elements(p_records))) desc,
      ((q.quote ->> 'messageId') in (select value ->> 'messageId' from jsonb_array_elements(p_records))
        or (q.quote ->> 'text') in (select value ->> 'text' from jsonb_array_elements(p_records))) desc nulls last,
      q.created_at, q.message_id limit 100
  loop
    perform internal.resolve_wecom_quoted_identity(pending_id, p_started_at);
  end loop;
  return result;
end;
$$;
revoke all on function public.ingest_wecom_bot_batch(text,jsonb,timestamptz,text) from public, anon, authenticated, service_role;
grant execute on function public.ingest_wecom_bot_batch(text,jsonb,timestamptz,text) to anon;

do $quoted_draft_sources$
declare definition text; old_fragment text; new_fragment text;
begin
  definition := pg_get_functiondef('internal.wecom_lp_trial_draft_source(text)'::regprocedure);
  old_fragment := $old$      ))
  ), data as ($old$;
  new_fragment := $new$      ))
    union all
    select m.* from internal.wecom_archive_messages m, source s
    where m.trial_handover_id = s.trial_handover_id and m.chat_id = s.chat_id
      and m.ingested_by = 'WeCom Bot Receiver' and m.message_type = 'text' and m.classification = 'other'
      and exists (select 1 from internal.wecom_bot_quoted_identities q where q.message_id = m.message_id
        and q.source_message_id = s.message_id and q.status = 'matched')
  ), data as ($new$;
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment) <> 1 then
    raise exception 'wecom_quoted_identity_source_drift';
  end if;
  definition := replace(definition,old_fragment,new_fragment);
  old_fragment := $old$'sentAt', r.sent_at, 'studentId', r.student_id$old$;
  new_fragment := $new$'sentAt', r.sent_at, 'studentId', r.student_id, 'studentNameHint', r.student_name_hint$new$;
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment) <> 1 then
    raise exception 'wecom_quoted_identity_messages_drift';
  end if;
  execute replace(definition,old_fragment,new_fragment);
end;
$quoted_draft_sources$;

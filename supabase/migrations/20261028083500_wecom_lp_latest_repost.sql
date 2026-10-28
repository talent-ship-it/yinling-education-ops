create function internal.wecom_lp_repost_subject(p_body text)
returns text language sql immutable strict set search_path = '' as $$
  with values as (
    select lower(regexp_replace(btrim(parts[2]), '[[:space:]]+', '', 'g')) as value
    from regexp_split_to_table(pg_catalog.normalize(p_body, 'NFKC'), E'\n') line
    cross join lateral regexp_match(line,
      '^[[:space:]【\[]*(安排科目|试听科目|课程科目|科目|学科|涉及科目)[】\]]*[[:space:]]*[:：][[:space:]]*(.*)$') parts
  )
  select case when count(distinct value) = 1 then min(value) end from values
  where value not in ('', '待定', '待确认', '待补充', '未知', '无', 'unknown', 'tbd', 'n/a');
$$;
revoke all on function internal.wecom_lp_repost_subject(text) from public, anon, authenticated, service_role;

create function internal.wecom_lp_repost_key(p_message internal.wecom_archive_messages)
returns text[] language plpgsql stable security invoker set search_path = '' as $$
declare handover internal.wecom_trial_handover_cases%rowtype; subject_value text;
  workflow_value text; name_value text; student_value text; candidate_count bigint;
begin
  if p_message.ingested_by <> 'WeCom Bot Receiver' or p_message.message_type <> 'text'
     or p_message.classification <> 'handover' or not coalesce(internal.wecom_is_lp_template(p_message.body), false) then
    return null;
  end if;
  subject_value := internal.wecom_lp_repost_subject(p_message.body);
  workflow_value := internal.wecom_lp_template_type(p_message.body);
  if subject_value is null or workflow_value is null then return null; end if;
  if p_message.trial_handover_id is not null then
    select * into handover from internal.wecom_trial_handover_cases where id = p_message.trial_handover_id;
    if not found or handover.chat_id <> p_message.chat_id
       or handover.status in ('identity_conflict', 'identity_ambiguous')
       or internal.wecom_identity_key(handover.wechat_name) is null then return null; end if;
    name_value := internal.wecom_name_key(coalesce(p_message.student_name_hint, handover.student_name));
    return array[p_message.chat_id, 'trial', handover.id::text, coalesce(name_value, ''), workflow_value, subject_value];
  end if;
  name_value := internal.wecom_name_key(coalesce(p_message.student_name_hint,
    btrim((regexp_match(p_message.body,
      E'(?m)^[[:space:]]*[【\\[]?(?:学生姓名|学生|姓名)[】\\]]?[[:space:]]*[:：][[:space:]]*([^\\n\\r]{1,240})'))[1])));
  if nullif(name_value, '') is null then return null; end if;
  select count(*), min(student ->> 'id') into candidate_count, student_value
  from public.ops_state state cross join lateral jsonb_array_elements(state.payload) student
  where state.entity = 'students' and coalesce(student ->> 'importArchived', 'false') <> 'true'
    and internal.wecom_name_key(student ->> 'name') = name_value
    and (p_message.student_id is null or student ->> 'id' = p_message.student_id)
    and (internal.wecom_identity_key(p_message.guardian_wechat_hint) is null
      or internal.wecom_identity_key(coalesce(student ->> 'guardianWechat', student ->> 'guardian'))
        = internal.wecom_identity_key(p_message.guardian_wechat_hint));
  if candidate_count <> 1 or nullif(student_value, '') is null then return null; end if;
  return array[p_message.chat_id, 'student', student_value, workflow_value, subject_value];
end;
$$;
revoke all on function internal.wecom_lp_repost_key(internal.wecom_archive_messages) from public, anon, authenticated, service_role;

create index wecom_lp_repost_room_time_idx
on internal.wecom_archive_messages(chat_id, sent_at desc, message_id desc)
where ingested_by = 'WeCom Bot Receiver' and message_type = 'text' and classification = 'handover';

create function internal.wecom_lp_superseded_by(p_message_id text)
returns text language plpgsql stable security invoker set search_path = '' as $$
declare source internal.wecom_archive_messages%rowtype; source_key text[]; latest_id text;
begin
  if exists(select 1 from internal.wecom_lp_confirmations c where c.source_message_id = p_message_id) then return null; end if;
  select * into source from internal.wecom_archive_messages where message_id = p_message_id;
  if not found then return null; end if;
  source_key := internal.wecom_lp_repost_key(source);
  if source_key is null then return null; end if;
  select m.message_id into latest_id from internal.wecom_archive_messages m
  where m.chat_id = source.chat_id and m.ingested_by = 'WeCom Bot Receiver'
    and m.message_type = 'text' and m.classification = 'handover'
    and (m.sent_at, m.message_id) > (source.sent_at, source.message_id)
    and internal.wecom_lp_repost_key(m) = source_key
  order by m.sent_at desc, m.message_id desc limit 1;
  return latest_id;
end;
$$;
revoke all on function internal.wecom_lp_superseded_by(text) from public, anon, authenticated, service_role;

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
  perform 1 from internal.wecom_archive_messages archived
  where archived.message_id in (
    select item ->> 'messageId' from pg_catalog.jsonb_array_elements(p_records) item
  )
  order by archived.message_id
  for update;
  for lock_key in
    select distinct pg_catalog.hashtextextended(rooms.chat_id, 0)
    from (
      select pg_catalog.btrim(item ->> 'chatId') as chat_id
      from pg_catalog.jsonb_array_elements(p_records) item
      where pg_catalog.jsonb_typeof(item -> 'chatId') = 'string'
      union
      select archived.chat_id from internal.wecom_archive_messages archived
      where archived.message_id in (
        select item ->> 'messageId' from pg_catalog.jsonb_array_elements(p_records) item
      )
    ) rooms
    where rooms.chat_id is not null
    order by 1
  loop
    perform pg_catalog.pg_advisory_xact_lock(lock_key);
  end loop;
end;
$function$;
revoke all on function internal.lock_wecom_batch_messages(jsonb) from public, anon, authenticated, service_role;

create function internal.lock_wecom_lp_repost_room()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.ingested_by = 'WeCom Bot Receiver' and new.message_type = 'text' and new.classification = 'handover'
     and internal.wecom_is_lp_template(new.body) then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.chat_id, 0));
  end if;
  return new;
end;
$$;
revoke all on function internal.lock_wecom_lp_repost_room() from public, anon, authenticated, service_role;
create trigger aaa_lock_wecom_lp_repost_room
before insert or update of body, classification, student_name_hint, guardian_wechat_hint,
  operations_owner_hint, course_planner_hint, student_id, trial_handover_id, sent_at, chat_id
on internal.wecom_archive_messages for each row execute function internal.lock_wecom_lp_repost_room();

do $latest_repost_contracts$
declare definition text; signature text; old_fragment text; new_fragment text; expected_count integer;
begin
  for signature in select unnest(array[
    'public.read_wecom_lp_drafts(text,text,boolean,text,integer)',
    'public.read_wecom_lp_drafts_in_range(text,text,boolean,text,integer,timestamptz,timestamptz)'
  ]) loop
    definition := pg_catalog.pg_get_functiondef(signature::regprocedure);
    old_fragment := E'  ), page as (\n';
    new_fragment := E'      and internal.wecom_lp_superseded_by(m.message_id) is null\n  ), page as (\n';
    if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment) <> 1 then
      raise exception 'wecom_latest_repost_reader_drift: %', signature;
    end if;
    execute replace(definition, old_fragment, new_fragment);
  end loop;

  signature := 'public.read_wecom_lp_draft(text,text,text,boolean)';
  definition := pg_catalog.pg_get_functiondef(signature::regprocedure);
  old_fragment := '  return source;';
  new_fragment := $new$  if internal.wecom_lp_superseded_by(p_source_message_id) is not null then
    raise exception using errcode = '40001', message = 'wecom_lp_source_superseded';
  end if;
  return source;$new$;
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment) <> 1 then
    raise exception 'wecom_latest_repost_single_reader_drift';
  end if;
  execute replace(definition,old_fragment,new_fragment);

  signature := 'public.confirm_wecom_lp_draft_atomic(text,uuid,text,text,text,text,jsonb,jsonb,jsonb,jsonb,text,boolean,text)';
  definition := pg_catalog.pg_get_functiondef(signature::regprocedure);
  old_fragment := $old$  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wecom-lp:' || p_source_message_id, 0));$old$;
  new_fragment := $new$  if exists(select 1 from internal.wecom_archive_messages m where m.message_id = p_source_message_id
    and not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(m.chat_id, 0))) then
    raise exception using errcode = '40001', message = 'wecom_lp_confirmation_busy';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wecom-lp:' || p_source_message_id, 0));$new$;
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment) <> 1 then
    raise exception 'wecom_latest_repost_confirmation_lock_drift';
  end if;
  definition := replace(definition,old_fragment,new_fragment);
  old_fragment := '  if prior.source_message_id is null then';
  new_fragment := $new$  if prior.source_message_id is null then
    if internal.wecom_lp_superseded_by(p_source_message_id) is not null then
      raise exception using errcode = '40001', message = 'wecom_lp_source_superseded';
    end if;$new$;
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment) <> 1 then
    raise exception 'wecom_latest_repost_confirmation_drift';
  end if;
  execute replace(definition,old_fragment,new_fragment);

  signature := 'public.read_wecom_handover_schedule_input(text,text,text[])';
  definition := pg_catalog.pg_get_functiondef(signature::regprocedure);
  for old_fragment, expected_count in select * from (values
    ('and internal.wecom_is_trial_lp_template(m.body) and (c.id is not null or b.id is not null)', 4),
    ('and internal.wecom_is_trial_lp_template(m.body) and internal.wecom_lp_draft_source(m.message_id) is not null', 1)
  ) targets(fragment, occurrences) loop
    if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment) <> expected_count then
      raise exception 'wecom_latest_repost_schedule_drift';
    end if;
    definition := replace(definition,old_fragment,old_fragment || ' and internal.wecom_lp_superseded_by(m.message_id) is null');
  end loop;
  execute definition;
end;
$latest_repost_contracts$;

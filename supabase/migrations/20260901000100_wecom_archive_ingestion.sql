-- Enterprise WeCom conversation archive ingestion.
--
-- The WeCom finance/data-intelligence worker decrypts authorised records
-- outside the browser and submits a small, normalised batch to the server-only
-- bridge.  This database boundary stores no callback keys, private keys or raw
-- encrypted envelopes.  It also refuses to guess a student: only one exact
-- active-student match can be projected into the ordinary message/file views.

create table if not exists internal.wecom_archive_messages (
  message_id text primary key check (length(message_id) between 1 and 240),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  chat_id text not null check (length(chat_id) between 1 and 240),
  sender_id text not null check (length(sender_id) between 1 and 240),
  sent_at timestamptz not null,
  message_type text not null check (message_type in ('text', 'image', 'file', 'mixed', 'other')),
  body text check (body is null or length(body) <= 12000),
  classification text not null check (classification in ('handover', 'renewal_follow_up', 'trial_scheduling', 'other')),
  student_name_hint text check (student_name_hint is null or length(student_name_hint) <= 240),
  guardian_wechat_hint text check (guardian_wechat_hint is null or length(guardian_wechat_hint) <= 240),
  student_id text check (student_id is null or length(student_id) between 1 and 120),
  match_status text not null check (match_status in ('pending', 'ambiguous', 'linked')),
  projected_message_id text,
  projected_at timestamptz,
  ingested_by text not null check (length(ingested_by) between 1 and 120),
  ingested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table internal.wecom_archive_messages enable row level security;
revoke all on table internal.wecom_archive_messages from public, anon, authenticated;

create index if not exists wecom_archive_messages_inbox_idx
  on internal.wecom_archive_messages (match_status, sent_at desc, message_id);
create index if not exists wecom_archive_messages_student_idx
  on internal.wecom_archive_messages (student_id, sent_at desc)
  where student_id is not null;

create table if not exists internal.wecom_archive_media (
  id uuid primary key default gen_random_uuid(),
  message_id text not null references internal.wecom_archive_messages(message_id) on delete restrict,
  media_key text not null check (length(media_key) between 1 and 240),
  file_name text not null check (length(file_name) between 1 and 180),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  byte_size integer not null check (byte_size between 1 and 3145728),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  content bytea not null,
  student_id text check (student_id is null or length(student_id) between 1 and 120),
  projected_file_id text,
  created_at timestamptz not null default now(),
  unique (message_id, media_key)
);

alter table internal.wecom_archive_media enable row level security;
revoke all on table internal.wecom_archive_media from public, anon, authenticated;

create index if not exists wecom_archive_media_student_idx
  on internal.wecom_archive_media (student_id, created_at desc)
  where student_id is not null;

create or replace function internal.wecom_plain_key(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select lower(regexp_replace(btrim(p_value), '[[:space:]]+', '', 'g'));
$$;

revoke all on function internal.wecom_plain_key(text) from public, anon, authenticated;

create or replace function internal.project_wecom_archive_message(
  p_message_id text,
  p_student_id text,
  p_actor text,
  p_require_exact_hint_match boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  archive internal.wecom_archive_messages%rowtype;
  files_state public.ops_state%rowtype;
  messages_state public.ops_state%rowtype;
  students_state public.ops_state%rowtype;
  current_student jsonb;
  next_student jsonb;
  next_students jsonb;
  next_files jsonb;
  next_messages jsonb;
  media internal.wecom_archive_media%rowtype;
  message_record jsonb;
  file_record jsonb;
  canonical_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'WeCom Archive Worker'), 120);
  canonical_projected_message_id text;
  canonical_projected_file_id text;
  message_changed boolean := false;
  file_count integer := 0;
  audit_id uuid;
begin
  select * into archive
  from internal.wecom_archive_messages source
  where source.message_id = p_message_id
  for update;
  if archive.message_id is null then
    raise exception using errcode = 'P0002', message = 'wecom_archive_message_not_found';
  end if;

  -- Keep the shared-state lock order lexical and identical for ingestion and
  -- later manual linking: files -> messages -> students.
  select * into files_state from public.ops_state state where state.entity = 'files' for update;
  select * into messages_state from public.ops_state state where state.entity = 'messages' for update;
  select * into students_state from public.ops_state state where state.entity = 'students' for update;
  if files_state.entity is null or messages_state.entity is null or students_state.entity is null
     or jsonb_typeof(files_state.payload) <> 'array'
     or jsonb_typeof(messages_state.payload) <> 'array'
     or jsonb_typeof(students_state.payload) <> 'array' then
    raise exception using errcode = '55000', message = 'wecom_projection_state_unavailable';
  end if;
  if (select count(*) from jsonb_array_elements(students_state.payload) student
      where student ->> 'id' = btrim(p_student_id)
        and coalesce(student ->> 'importArchived', 'false') <> 'true') <> 1 then
    raise exception using errcode = '22023', message = 'wecom_projection_student_not_found';
  end if;
  current_student := (
    select student
    from jsonb_array_elements(students_state.payload) student
    where student ->> 'id' = btrim(p_student_id)
      and coalesce(student ->> 'importArchived', 'false') <> 'true'
    limit 1
  );
  if p_require_exact_hint_match then
    if (archive.student_name_hint is null and archive.guardian_wechat_hint is null)
       or (select count(*) from jsonb_array_elements(students_state.payload) student
           where coalesce(student ->> 'importArchived', 'false') <> 'true'
             and (archive.student_name_hint is null
               or internal.wecom_plain_key(student ->> 'name') = internal.wecom_plain_key(archive.student_name_hint))
             and (archive.guardian_wechat_hint is null
               or internal.wecom_plain_key(coalesce(nullif(btrim(student ->> 'guardianWechat'), ''), student ->> 'guardian'))
                 = internal.wecom_plain_key(archive.guardian_wechat_hint))) <> 1
       or (archive.student_name_hint is not null
         and internal.wecom_plain_key(current_student ->> 'name') <> internal.wecom_plain_key(archive.student_name_hint))
       or (archive.guardian_wechat_hint is not null
         and internal.wecom_plain_key(coalesce(nullif(btrim(current_student ->> 'guardianWechat'), ''), current_student ->> 'guardian'))
           <> internal.wecom_plain_key(archive.guardian_wechat_hint)) then
      raise exception using errcode = '40001', message = 'wecom_projection_identity_changed';
    end if;
  end if;

  canonical_projected_message_id := 'WECOM-' || substr(encode(extensions.digest(archive.message_id, 'sha256'), 'hex'), 1, 32);
  next_messages := messages_state.payload;
  if not exists (
    select 1 from jsonb_array_elements(messages_state.payload) item
    where item ->> 'id' = canonical_projected_message_id
  ) then
    message_record := jsonb_build_object(
      'id', canonical_projected_message_id,
      'studentId', btrim(p_student_id),
      'kind', case archive.classification
        when 'handover' then '企业微信 · 信息交接表'
        when 'renewal_follow_up' then '企业微信 · 续费前跟进'
        when 'trial_scheduling' then '企业微信 · 试听排课'
        else '企业微信 · 群聊归档'
      end,
      'recipient', '群聊 ' || archive.chat_id,
      'body', coalesce(nullif(archive.body, ''), case archive.message_type
        when 'image' then '[企业微信图片已自动归档]'
        when 'file' then '[企业微信文件已自动归档]'
        else '[企业微信记录已归档]'
      end),
      'status', '仅内部',
      'createdAt', archive.sent_at
    );
    next_messages := jsonb_build_array(message_record) || next_messages;
    message_changed := true;
  elsif not exists (
    select 1 from jsonb_array_elements(messages_state.payload) item
    where item ->> 'id' = canonical_projected_message_id
      and item ->> 'studentId' = btrim(p_student_id)
  ) then
    raise exception using errcode = '23505', message = 'wecom_projected_message_identity_conflict';
  end if;

  next_files := files_state.payload;
  for media in
    select * from internal.wecom_archive_media source
    where source.message_id = archive.message_id
    order by source.created_at, source.id
    for update
  loop
    canonical_projected_file_id := 'WECOM-FILE-' || media.id::text;
    if media.projected_file_id is not null then
      if media.projected_file_id <> canonical_projected_file_id
         or media.student_id is distinct from btrim(p_student_id)
         or not exists (
           select 1 from jsonb_array_elements(files_state.payload) item
           where item ->> 'id' = media.projected_file_id
             and item ->> 'studentId' = btrim(p_student_id)
         ) then
        raise exception using errcode = '55000', message = 'wecom_media_projection_mismatch';
      end if;
      continue;
    end if;
    if exists (select 1 from jsonb_array_elements(next_files) item where item ->> 'id' = canonical_projected_file_id) then
      raise exception using errcode = '23505', message = 'wecom_projected_file_id_conflict';
    end if;
    file_record := jsonb_strip_nulls(jsonb_build_object(
      'id', canonical_projected_file_id,
      'studentId', btrim(p_student_id),
      'title', case archive.classification
        when 'renewal_follow_up' then '企业微信续费前跟进截图 · ' || media.file_name
        when 'handover' then '企业微信信息交接附件 · ' || media.file_name
        else '企业微信归档附件 · ' || media.file_name
      end,
      'type', case
        when media.content_type = 'application/pdf' then '其他'
        when archive.classification = 'renewal_follow_up' then '续课 FU'
        else 'FU'
      end,
      'source', '/api/integrations/wecom/media/' || media.id::text,
      'addedAt', archive.sent_at,
      'fuCategory', case
        when media.content_type = 'application/pdf' then null
        when archive.classification = 'renewal_follow_up' then 'renewal_update'
        else 'parent_communication'
      end
    ));
    next_files := jsonb_build_array(file_record) || next_files;
    update internal.wecom_archive_media source
    set student_id = btrim(p_student_id), projected_file_id = canonical_projected_file_id
    where source.id = media.id;
    file_count := file_count + 1;
  end loop;

  if message_changed then
    update public.ops_state state
    set payload = next_messages,
        version = state.version + 1,
        updated_at = now(),
        updated_by = canonical_actor
    where state.entity = 'messages'
    returning state.* into messages_state;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('messages', messages_state.version, messages_state.updated_by);
  end if;

  if file_count > 0 then
    if jsonb_typeof(current_student -> 'files') <> 'number'
       or (current_student ->> 'files')::numeric <> trunc((current_student ->> 'files')::numeric)
       or (current_student ->> 'files')::numeric < 0
       or (current_student ->> 'files')::numeric > 1000000 - file_count then
      raise exception using errcode = '22023', message = 'wecom_student_file_count_invalid';
    end if;
    next_student := jsonb_set(
      current_student,
      '{files}',
      to_jsonb((current_student ->> 'files')::integer + file_count),
      false
    );
    select jsonb_agg(
      case when student ->> 'id' = btrim(p_student_id) then next_student else student end
      order by ordinality
    ) into next_students
    from jsonb_array_elements(students_state.payload) with ordinality source(student, ordinality);
    update public.ops_state state
    set payload = next_files,
        version = state.version + 1,
        updated_at = now(),
        updated_by = canonical_actor
    where state.entity = 'files'
    returning state.* into files_state;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('files', files_state.version, files_state.updated_by);
    update public.ops_state state
    set payload = next_students,
        version = state.version + 1,
        updated_at = now(),
        updated_by = canonical_actor
    where state.entity = 'students'
    returning state.* into students_state;
    insert into public.ops_mutation_log(entity, version, actor)
    values ('students', students_state.version, students_state.updated_by);
  end if;

  update internal.wecom_archive_messages source
  set student_id = btrim(p_student_id),
      match_status = 'linked',
      projected_message_id = canonical_projected_message_id,
      projected_at = coalesce(source.projected_at, now()),
      updated_at = now()
  where source.message_id = archive.message_id;

  audit_id := internal.append_operational_contract_audit(
    'wecom.archive.projected', canonical_actor, 'wecom_message', archive.message_id,
    jsonb_build_object(
      'studentId', btrim(p_student_id),
      'classification', archive.classification,
      'messageProjected', message_changed,
      'fileCount', file_count
    )
  );
  return jsonb_build_object(
    'messageId', archive.message_id,
    'studentId', btrim(p_student_id),
    'messageProjected', message_changed,
    'fileCount', file_count,
    'auditEntryId', audit_id
  );
end;
$$;

revoke all on function internal.project_wecom_archive_message(text, text, text, boolean)
  from public, anon, authenticated;

create or replace function public.ingest_wecom_archive_batch(
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
  media_source jsonb;
  existing internal.wecom_archive_messages%rowtype;
  decoded bytea;
  canonical_media jsonb;
  canonical_media_items jsonb;
  canonical_record jsonb;
  canonical_body text;
  canonical_student_hint text;
  canonical_guardian_hint text;
  canonical_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'WeCom Archive Worker'), 120);
  record_hash text;
  media_hash text;
  linked_student_id text;
  candidate_count integer;
  inserted_count integer := 0;
  duplicate_count integer := 0;
  linked_count integer := 0;
  ambiguous_count integer := 0;
  pending_count integer := 0;
  projected_file_count integer := 0;
  projection jsonb;
  match_status text;
  total_decoded_bytes bigint := 0;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  -- `p_started_at` is the permanent post-join boundary, not a rolling
  -- lookback.  It must remain valid after the integration has run for months.
  if p_started_at is null or p_started_at > now() + interval '5 minutes'
     or jsonb_typeof(p_records) <> 'array'
     or jsonb_array_length(p_records) < 1
     or jsonb_array_length(p_records) > 50
     or octet_length(p_records::text) > 8388608 then
    raise exception using errcode = '22023', message = 'invalid_wecom_archive_batch';
  end if;

  for source in select value from jsonb_array_elements(p_records)
  loop
    if jsonb_typeof(source) <> 'object'
       or source - 'messageId' - 'chatId' - 'senderId' - 'sentAt' - 'messageType'
         - 'text' - 'classification' - 'studentNameHint' - 'guardianWechatHint' - 'media' <> '{}'::jsonb
       or coalesce(source ->> 'messageId', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,239}$'
       or nullif(btrim(source ->> 'chatId'), '') is null
       or length(source ->> 'chatId') > 240
       or nullif(btrim(source ->> 'senderId'), '') is null
       or length(source ->> 'senderId') > 240
       or source ->> 'messageType' not in ('text', 'image', 'file', 'mixed', 'other')
       or source ->> 'classification' not in ('handover', 'renewal_follow_up', 'trial_scheduling', 'other')
       or jsonb_typeof(source -> 'media') <> 'array'
       or jsonb_array_length(source -> 'media') > 10 then
      raise exception using errcode = '22023', message = 'invalid_wecom_archive_record';
    end if;
    begin
      if (source ->> 'sentAt')::timestamptz < p_started_at
         or (source ->> 'sentAt')::timestamptz > now() + interval '5 minutes' then
        raise exception using errcode = '22023', message = 'wecom_archive_record_outside_window';
      end if;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'invalid_wecom_archive_timestamp';
    end;

    canonical_body := nullif(btrim(coalesce(source ->> 'text', '')), '');
    canonical_student_hint := nullif(btrim(coalesce(source ->> 'studentNameHint', '')), '');
    canonical_guardian_hint := nullif(btrim(coalesce(source ->> 'guardianWechatHint', '')), '');
    if length(coalesce(canonical_body, '')) > 12000
       or length(coalesce(canonical_student_hint, '')) > 240
       or length(coalesce(canonical_guardian_hint, '')) > 240 then
      raise exception using errcode = '22023', message = 'wecom_archive_text_too_long';
    end if;

    canonical_media_items := '[]'::jsonb;
    for media_source in select value from jsonb_array_elements(source -> 'media')
    loop
      if jsonb_typeof(media_source) <> 'object'
         or media_source - 'mediaKey' - 'fileName' - 'contentType' - 'contentBase64' - 'sha256' <> '{}'::jsonb
         or coalesce(media_source ->> 'mediaKey', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,239}$'
         or nullif(btrim(media_source ->> 'fileName'), '') is null
         or length(media_source ->> 'fileName') > 180
         or media_source ->> 'contentType' not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
         or coalesce(media_source ->> 'sha256', '') !~ '^[a-f0-9]{64}$'
         or nullif(media_source ->> 'contentBase64', '') is null
         or length(media_source ->> 'contentBase64') > 4194304 then
        raise exception using errcode = '22023', message = 'invalid_wecom_archive_media';
      end if;
      if exists (
        select 1 from jsonb_array_elements(canonical_media_items) item
        where item ->> 'mediaKey' = media_source ->> 'mediaKey'
      ) then
        raise exception using errcode = '22023', message = 'wecom_archive_duplicate_media_key';
      end if;
      begin
        decoded := decode(media_source ->> 'contentBase64', 'base64');
      exception when others then
        raise exception using errcode = '22023', message = 'invalid_wecom_archive_media_base64';
      end;
      if octet_length(decoded) < 1 or octet_length(decoded) > 3145728 then
        raise exception using errcode = '22023', message = 'wecom_archive_media_size_out_of_range';
      end if;
      total_decoded_bytes := total_decoded_bytes + octet_length(decoded);
      if total_decoded_bytes > 6291456 then
        raise exception using errcode = '22023', message = 'wecom_archive_batch_media_too_large';
      end if;
      media_hash := encode(extensions.digest(decoded, 'sha256'), 'hex');
      if media_hash <> media_source ->> 'sha256'
         or (media_source ->> 'contentType' = 'image/jpeg' and substring(decoded from 1 for 3) <> decode('ffd8ff', 'hex'))
         or (media_source ->> 'contentType' = 'image/png' and substring(decoded from 1 for 8) <> decode('89504e470d0a1a0a', 'hex'))
         or (media_source ->> 'contentType' = 'image/webp' and (
           substring(decoded from 1 for 4) <> convert_to('RIFF', 'UTF8')
           or substring(decoded from 9 for 4) <> convert_to('WEBP', 'UTF8')
         ))
         or (media_source ->> 'contentType' = 'application/pdf' and substring(decoded from 1 for 5) <> convert_to('%PDF-', 'UTF8')) then
        raise exception using errcode = '22023', message = 'wecom_archive_media_integrity_mismatch';
      end if;
      canonical_media := jsonb_build_object(
        'mediaKey', media_source ->> 'mediaKey',
        'fileName', btrim(media_source ->> 'fileName'),
        'contentType', media_source ->> 'contentType',
        'byteSize', octet_length(decoded),
        'sha256', media_hash
      );
      canonical_media_items := canonical_media_items || jsonb_build_array(canonical_media);
    end loop;

    canonical_record := jsonb_strip_nulls(jsonb_build_object(
      'messageId', source ->> 'messageId',
      'chatId', btrim(source ->> 'chatId'),
      'senderId', btrim(source ->> 'senderId'),
      'sentAt', (source ->> 'sentAt')::timestamptz,
      'messageType', source ->> 'messageType',
      'text', canonical_body,
      'classification', source ->> 'classification',
      'studentNameHint', canonical_student_hint,
      'guardianWechatHint', canonical_guardian_hint,
      'media', canonical_media_items
    ));
    record_hash := encode(extensions.digest(canonical_record::text, 'sha256'), 'hex');
    -- Serialize first delivery of one message ID.  FOR UPDATE alone cannot
    -- lock an absent row, so without this exact-key lock concurrent retries
    -- could race into a primary-key error instead of deterministic deduping.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(source ->> 'messageId', 0)
    );
    select * into existing from internal.wecom_archive_messages item
    where item.message_id = source ->> 'messageId'
    for update;
    if existing.message_id is not null then
      if existing.content_sha256 <> record_hash then
        raise exception using errcode = '23505', message = 'wecom_archive_idempotency_conflict';
      end if;
      duplicate_count := duplicate_count + 1;
      continue;
    end if;

    linked_student_id := null;
    candidate_count := 0;
    if canonical_student_hint is not null or canonical_guardian_hint is not null then
      select count(*), min(student ->> 'id')
      into candidate_count, linked_student_id
      from jsonb_array_elements((select payload from public.ops_state where entity = 'students')) student
      where coalesce(student ->> 'importArchived', 'false') <> 'true'
        and (canonical_student_hint is null
          or internal.wecom_plain_key(student ->> 'name') = internal.wecom_plain_key(canonical_student_hint))
        and (canonical_guardian_hint is null
          or internal.wecom_plain_key(coalesce(nullif(btrim(student ->> 'guardianWechat'), ''), student ->> 'guardian'))
            = internal.wecom_plain_key(canonical_guardian_hint));
    end if;
    match_status := case when candidate_count = 1 then 'linked'
      when candidate_count > 1 then 'ambiguous'
      else 'pending' end;
    if match_status <> 'linked' then linked_student_id := null; end if;

    insert into internal.wecom_archive_messages (
      message_id, content_sha256, chat_id, sender_id, sent_at, message_type,
      body, classification, student_name_hint, guardian_wechat_hint,
      student_id, match_status, ingested_by
    ) values (
      source ->> 'messageId', record_hash, btrim(source ->> 'chatId'), btrim(source ->> 'senderId'),
      (source ->> 'sentAt')::timestamptz, source ->> 'messageType', canonical_body,
      source ->> 'classification', canonical_student_hint, canonical_guardian_hint,
      linked_student_id, match_status, canonical_actor
    );
    for media_source in select value from jsonb_array_elements(source -> 'media')
    loop
      decoded := decode(media_source ->> 'contentBase64', 'base64');
      insert into internal.wecom_archive_media (
        message_id, media_key, file_name, content_type, byte_size,
        content_sha256, content, student_id
      ) values (
        source ->> 'messageId', media_source ->> 'mediaKey', btrim(media_source ->> 'fileName'),
        media_source ->> 'contentType', octet_length(decoded), media_source ->> 'sha256', decoded,
        linked_student_id
      );
    end loop;
    inserted_count := inserted_count + 1;
    if match_status = 'linked' then
      projection := internal.project_wecom_archive_message(
        source ->> 'messageId', linked_student_id, canonical_actor, true
      );
      linked_count := linked_count + 1;
      projected_file_count := projected_file_count + coalesce((projection ->> 'fileCount')::integer, 0);
    elsif match_status = 'ambiguous' then
      ambiguous_count := ambiguous_count + 1;
    else
      pending_count := pending_count + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'inserted', inserted_count,
    'duplicates', duplicate_count,
    'linked', linked_count,
    'ambiguous', ambiguous_count,
    'pending', pending_count,
    'projectedFiles', projected_file_count
  );
end;
$$;

create or replace function public.read_wecom_archive_inbox(
  p_secret text,
  p_limit integer default 100
)
returns table (
  message_id text,
  chat_id text,
  sender_id text,
  sent_at timestamptz,
  message_type text,
  body text,
  classification text,
  student_name_hint text,
  guardian_wechat_hint text,
  student_id text,
  match_status text,
  media_count bigint,
  projected_at timestamptz,
  ingested_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if p_limit < 1 or p_limit > 250 then
    raise exception using errcode = '22023', message = 'invalid_wecom_archive_limit';
  end if;
  return query
  select source.message_id, source.chat_id, source.sender_id, source.sent_at,
    source.message_type, source.body, source.classification,
    source.student_name_hint, source.guardian_wechat_hint, source.student_id,
    source.match_status, count(media.id), source.projected_at, source.ingested_at
  from internal.wecom_archive_messages source
  left join internal.wecom_archive_media media on media.message_id = source.message_id
  group by source.message_id
  order by source.sent_at desc, source.message_id
  limit p_limit;
end;
$$;

create or replace function public.link_wecom_archive_message(
  p_secret text,
  p_message_id text,
  p_student_id text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  source internal.wecom_archive_messages%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  if nullif(btrim(p_message_id), '') is null or length(p_message_id) > 240
     or nullif(btrim(p_student_id), '') is null or length(p_student_id) > 120
     or nullif(btrim(p_actor), '') is null then
    raise exception using errcode = '22023', message = 'invalid_wecom_archive_link';
  end if;
  select * into source from internal.wecom_archive_messages item
  where item.message_id = btrim(p_message_id)
  for update;
  if source.message_id is null then
    raise exception using errcode = 'P0002', message = 'wecom_archive_message_not_found';
  end if;
  if source.student_id is not null and source.student_id <> btrim(p_student_id) then
    raise exception using errcode = '23505', message = 'wecom_archive_link_conflict';
  end if;
  return internal.project_wecom_archive_message(source.message_id, btrim(p_student_id), p_actor, false);
end;
$$;

create or replace function public.get_wecom_archive_media(
  p_secret text,
  p_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  media internal.wecom_archive_media%rowtype;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select * into media from internal.wecom_archive_media source where source.id = p_id;
  if media.id is null or media.student_id is null or media.projected_file_id is null then
    return null;
  end if;
  return jsonb_build_object(
    'id', media.id,
    'student_id', media.student_id,
    'file_name', media.file_name,
    'content_type', media.content_type,
    'byte_size', media.byte_size,
    'content_base64', encode(media.content, 'base64')
  );
end;
$$;

create or replace function public.get_wecom_archive_status(p_secret text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not internal.verify_ops_secret(p_secret) then
    raise exception using errcode = '42501', message = 'invalid_ops_secret';
  end if;
  select jsonb_build_object(
    'total', count(*),
    'linked', count(*) filter (where match_status = 'linked'),
    'ambiguous', count(*) filter (where match_status = 'ambiguous'),
    'pending', count(*) filter (where match_status = 'pending'),
    'latestSentAt', max(sent_at),
    'latestIngestedAt', max(ingested_at)
  ) into result
  from internal.wecom_archive_messages;
  return result;
end;
$$;

revoke all on function public.ingest_wecom_archive_batch(text, jsonb, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.read_wecom_archive_inbox(text, integer)
  from public, anon, authenticated;
revoke all on function public.link_wecom_archive_message(text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.get_wecom_archive_media(text, uuid)
  from public, anon, authenticated;
revoke all on function public.get_wecom_archive_status(text)
  from public, anon, authenticated;

grant execute on function public.ingest_wecom_archive_batch(text, jsonb, timestamptz, text)
  to anon;
grant execute on function public.read_wecom_archive_inbox(text, integer)
  to anon;
grant execute on function public.link_wecom_archive_message(text, text, text, text)
  to anon;
grant execute on function public.get_wecom_archive_media(text, uuid)
  to anon;
grant execute on function public.get_wecom_archive_status(text)
  to anon;

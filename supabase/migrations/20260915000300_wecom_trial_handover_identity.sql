-- Trial handovers arrive before the student is in the active roster.  Keep
-- that workflow separate from active-student auto-linking: an explicit
-- parent/WeChat display name creates an internal handover case, and a later
-- explicit student name with the same WeChat name confirms that case.  This
-- migration deliberately does not create students, LPs, schedules, payments,
-- or tasks from a bot callback.

alter table internal.wecom_archive_messages
  add column if not exists operations_owner_hint text
    check (operations_owner_hint is null or pg_catalog.length(operations_owner_hint) <= 240),
  add column if not exists course_planner_hint text
    check (course_planner_hint is null or pg_catalog.length(course_planner_hint) <= 240);

create or replace function internal.wecom_identity_key(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $wecom_identity_key$
  select pg_catalog.lower(pg_catalog.regexp_replace(
    pg_catalog.btrim(p_value),
    '[[:space:]]+',
    '',
    'g'
  ));
$wecom_identity_key$;

revoke all on function internal.wecom_identity_key(text)
  from public, anon, authenticated, service_role;

create table if not exists internal.wecom_trial_handover_cases (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null check (pg_catalog.length(chat_id) between 1 and 240),
  wechat_name text not null check (pg_catalog.length(wechat_name) between 1 and 240),
  wechat_name_key text not null check (pg_catalog.length(wechat_name_key) between 1 and 240),
  student_name text check (student_name is null or pg_catalog.length(student_name) between 1 and 240),
  operations_owner text check (operations_owner is null or pg_catalog.length(operations_owner) between 1 and 240),
  course_planner text check (course_planner is null or pg_catalog.length(course_planner) between 1 and 240),
  status text not null check (status in ('awaiting_student_name', 'identified', 'identity_conflict')),
  handover_message_id text references internal.wecom_archive_messages(message_id) on delete restrict,
  identity_message_id text references internal.wecom_archive_messages(message_id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (chat_id, wechat_name_key)
);

alter table internal.wecom_trial_handover_cases enable row level security;
revoke all on table internal.wecom_trial_handover_cases from public, anon, authenticated;

alter table internal.wecom_archive_messages
  add column if not exists trial_handover_id uuid
    references internal.wecom_trial_handover_cases(id) on delete restrict;

create index if not exists wecom_trial_handover_cases_status_idx
  on internal.wecom_trial_handover_cases (status, updated_at desc, id);
create index if not exists wecom_archive_messages_trial_handover_idx
  on internal.wecom_archive_messages (trial_handover_id, sent_at desc, message_id)
  where trial_handover_id is not null;

create or replace function internal.upsert_wecom_trial_handover_case(
  p_message_id text,
  p_actor text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  archive internal.wecom_archive_messages%rowtype;
  handover_case internal.wecom_trial_handover_cases%rowtype;
  canonical_wechat text;
  canonical_wechat_key text;
  resolved_operations_owner text;
  resolved_course_planner text;
  canonical_actor text := left(coalesce(nullif(pg_catalog.btrim(p_actor), ''), 'WeCom Bot Receiver'), 120);
  changed boolean := false;
begin
  select * into archive
  from internal.wecom_archive_messages source
  where source.message_id = p_message_id
  for update;

  if not found
     or archive.ingested_by <> 'WeCom Bot Receiver'
     or archive.message_type <> 'text'
     or archive.classification <> 'handover'
     or archive.guardian_wechat_hint is null then
    return pg_catalog.jsonb_build_object('status', 'not_eligible', 'changed', false);
  end if;

  canonical_wechat := nullif(pg_catalog.btrim(archive.guardian_wechat_hint), '');
  canonical_wechat_key := internal.wecom_identity_key(canonical_wechat);
  if canonical_wechat is null or canonical_wechat_key = '' then
    return pg_catalog.jsonb_build_object('status', 'not_eligible', 'changed', false);
  end if;

  -- The structured parser is authoritative for new callbacks.  The bounded
  -- body fallback preserves useful ownership fields from existing handovers
  -- submitted before this migration without accepting arbitrary chat prose.
  resolved_operations_owner := coalesce(
    archive.operations_owner_hint,
    nullif(pg_catalog.btrim((pg_catalog.regexp_match(
      coalesce(archive.body, ''),
      E'(?m)^[[:space:]]*(?:【)?(?:教务老师|负责教务|对接教务|教务)(?:】)?[[:space:]]*[:：][[:space:]]*([^\\n,，;；]{1,240})'
    ))[1]), '')
  );
  resolved_course_planner := coalesce(
    archive.course_planner_hint,
    nullif(pg_catalog.btrim((pg_catalog.regexp_match(
      coalesce(archive.body, ''),
      E'(?m)^[[:space:]]*(?:【)?(?:课程规划老师|课程规划师|课程规划)(?:】)?[[:space:]]*[:：][[:space:]]*([^\\n,，;；]{1,240})'
    ))[1]), '')
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(archive.chat_id || chr(31) || canonical_wechat_key, 0)
  );
  select * into handover_case
  from internal.wecom_trial_handover_cases source
  where source.chat_id = archive.chat_id
    and source.wechat_name_key = canonical_wechat_key
  for update;

  if not found then
    insert into internal.wecom_trial_handover_cases (
      chat_id, wechat_name, wechat_name_key, student_name,
      operations_owner, course_planner, status,
      handover_message_id, identity_message_id
    ) values (
      archive.chat_id, canonical_wechat, canonical_wechat_key, archive.student_name_hint,
      resolved_operations_owner, resolved_course_planner,
      case when archive.student_name_hint is null then 'awaiting_student_name' else 'identified' end,
      archive.message_id,
      case when archive.student_name_hint is null then null else archive.message_id end
    )
    returning * into handover_case;
    changed := true;
  elsif handover_case.student_name is not null
    and archive.student_name_hint is not null
    and internal.wecom_name_key(handover_case.student_name) <> internal.wecom_name_key(archive.student_name_hint) then
    if handover_case.status <> 'identity_conflict' then
      update internal.wecom_trial_handover_cases
      set status = 'identity_conflict',
          updated_at = pg_catalog.now()
      where id = handover_case.id
      returning * into handover_case;
      changed := true;
    end if;
  else
    if handover_case.student_name is distinct from coalesce(handover_case.student_name, archive.student_name_hint)
       or handover_case.operations_owner is distinct from coalesce(handover_case.operations_owner, resolved_operations_owner)
       or handover_case.course_planner is distinct from coalesce(handover_case.course_planner, resolved_course_planner)
       or handover_case.handover_message_id is null
       or (handover_case.identity_message_id is null and archive.student_name_hint is not null)
       or (handover_case.status <> 'identity_conflict'
         and handover_case.status is distinct from case
           when coalesce(handover_case.student_name, archive.student_name_hint) is null then 'awaiting_student_name'
           else 'identified'
         end) then
      update internal.wecom_trial_handover_cases
      set student_name = coalesce(handover_case.student_name, archive.student_name_hint),
          operations_owner = coalesce(handover_case.operations_owner, resolved_operations_owner),
          course_planner = coalesce(handover_case.course_planner, resolved_course_planner),
          handover_message_id = coalesce(handover_case.handover_message_id, archive.message_id),
          identity_message_id = coalesce(
            handover_case.identity_message_id,
            case when archive.student_name_hint is null then null else archive.message_id end
          ),
          status = case
            when handover_case.status = 'identity_conflict' then 'identity_conflict'
            when coalesce(handover_case.student_name, archive.student_name_hint) is null then 'awaiting_student_name'
            else 'identified'
          end,
          updated_at = pg_catalog.now()
      where id = handover_case.id
      returning * into handover_case;
      changed := true;
    end if;
  end if;

  if archive.trial_handover_id is null then
    update internal.wecom_archive_messages
    set trial_handover_id = handover_case.id,
        updated_at = pg_catalog.now()
    where message_id = archive.message_id;
    changed := true;
  elsif archive.trial_handover_id <> handover_case.id then
    raise exception using errcode = '23505', message = 'wecom_trial_handover_message_conflict';
  end if;

  if changed then
    perform internal.append_operational_contract_audit(
      'wecom.bot.trial_handover_identity',
      canonical_actor,
      'wecom_trial_handover',
      handover_case.id::text,
      pg_catalog.jsonb_build_object(
        'messageId', archive.message_id,
        'status', handover_case.status,
        'studentNameKnown', handover_case.student_name is not null,
        'hasOperationsOwner', handover_case.operations_owner is not null,
        'hasCoursePlanner', handover_case.course_planner is not null
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'status', handover_case.status,
    'caseId', handover_case.id,
    'changed', changed
  );
end;
$$;

revoke all on function internal.upsert_wecom_trial_handover_case(text, text)
  from public, anon, authenticated, service_role;

-- Preserve the current source's lock-order and active-student matching fixes,
-- while extending only the private bot payload contract with the two staff
-- assignment hints.  Abort on unexpected definition drift rather than
-- silently weakening a later migration.
do $wecom_trial_handover_bot_contract$
declare
  definition text;
  old_fragment text;
  new_fragment text;
begin
  definition := pg_catalog.pg_get_functiondef(
    'public.ingest_wecom_bot_batch(text,jsonb,timestamp with time zone,text)'::pg_catalog.regprocedure
  );
  if pg_catalog.strpos(definition, '''operationsOwnerHint''') = 0 then
    for old_fragment, new_fragment in
      select * from (values
        (
          $old$  canonical_guardian_hint text;
  auto_result jsonb;$old$,
          $new$  canonical_guardian_hint text;
  canonical_operations_owner_hint text;
  canonical_course_planner_hint text;
  auto_result jsonb;$new$
        ),
        (
          $old$         - 'classification' - 'studentNameHint' - 'guardianWechatHint' <> '{}'::jsonb$old$,
          $new$         - 'classification' - 'studentNameHint' - 'guardianWechatHint'
         - 'operationsOwnerHint' - 'coursePlannerHint' <> '{}'::jsonb$new$
        ),
        (
          $old$       or (source ? 'guardianWechatHint' and source -> 'guardianWechatHint' is not null
         and pg_catalog.jsonb_typeof(source -> 'guardianWechatHint') <> 'string')
       or pg_catalog.length(coalesce(source ->> 'text', '')) > 12000
       or pg_catalog.length(coalesce(source ->> 'studentNameHint', '')) > 240
       or pg_catalog.length(coalesce(source ->> 'guardianWechatHint', '')) > 240 then$old$,
          $new$       or (source ? 'guardianWechatHint' and source -> 'guardianWechatHint' is not null
         and pg_catalog.jsonb_typeof(source -> 'guardianWechatHint') <> 'string')
       or (source ? 'operationsOwnerHint' and source -> 'operationsOwnerHint' is not null
         and pg_catalog.jsonb_typeof(source -> 'operationsOwnerHint') <> 'string')
       or (source ? 'coursePlannerHint' and source -> 'coursePlannerHint' is not null
         and pg_catalog.jsonb_typeof(source -> 'coursePlannerHint') <> 'string')
       or pg_catalog.length(coalesce(source ->> 'text', '')) > 12000
       or pg_catalog.length(coalesce(source ->> 'studentNameHint', '')) > 240
       or pg_catalog.length(coalesce(source ->> 'guardianWechatHint', '')) > 240
       or pg_catalog.length(coalesce(source ->> 'operationsOwnerHint', '')) > 240
       or pg_catalog.length(coalesce(source ->> 'coursePlannerHint', '')) > 240 then$new$
        ),
        (
          $old$    canonical_guardian_hint := nullif(pg_catalog.btrim(coalesce(source ->> 'guardianWechatHint', '')), '');
    if message_type <> 'text' and (
      canonical_classification <> 'other'
      or canonical_student_hint is not null
      or canonical_guardian_hint is not null
    ) then$old$,
          $new$    canonical_guardian_hint := nullif(pg_catalog.btrim(coalesce(source ->> 'guardianWechatHint', '')), '');
    canonical_operations_owner_hint := nullif(pg_catalog.btrim(coalesce(source ->> 'operationsOwnerHint', '')), '');
    canonical_course_planner_hint := nullif(pg_catalog.btrim(coalesce(source ->> 'coursePlannerHint', '')), '');
    if message_type <> 'text' and (
      canonical_classification <> 'other'
      or canonical_student_hint is not null
      or canonical_guardian_hint is not null
      or canonical_operations_owner_hint is not null
      or canonical_course_planner_hint is not null
    ) then$new$
        ),
        (
          $old$      'studentNameHint', canonical_student_hint,
      'guardianWechatHint', canonical_guardian_hint
    ));$old$,
          $new$      'studentNameHint', canonical_student_hint,
      'guardianWechatHint', canonical_guardian_hint,
      'operationsOwnerHint', canonical_operations_owner_hint,
      'coursePlannerHint', canonical_course_planner_hint
    ));$new$
        ),
        (
          $old$         and existing.student_name_hint is null
         and existing.guardian_wechat_hint is null
         and existing.message_type = message_type$old$,
          $new$         and existing.student_name_hint is null
         and existing.guardian_wechat_hint is null
         and existing.operations_owner_hint is null
         and existing.course_planner_hint is null
         and existing.message_type = message_type$new$
        ),
        (
          $old$            student_name_hint = canonical_student_hint,
            guardian_wechat_hint = canonical_guardian_hint,
            updated_at = pg_catalog.now()$old$,
          $new$            student_name_hint = canonical_student_hint,
            guardian_wechat_hint = canonical_guardian_hint,
            operations_owner_hint = canonical_operations_owner_hint,
            course_planner_hint = canonical_course_planner_hint,
            updated_at = pg_catalog.now()$new$
        ),
        (
          $old$      body, classification, student_name_hint, guardian_wechat_hint,
      student_id, match_status, ingested_by$old$,
          $new$      body, classification, student_name_hint, guardian_wechat_hint,
      operations_owner_hint, course_planner_hint,
      student_id, match_status, ingested_by$new$
        ),
        (
          $old$      canonical_classification, canonical_student_hint, canonical_guardian_hint,
      null, 'pending', canonical_actor$old$,
          $new$      canonical_classification, canonical_student_hint, canonical_guardian_hint,
      canonical_operations_owner_hint, canonical_course_planner_hint,
      null, 'pending', canonical_actor$new$
        )
      ) as patches(old_fragment, new_fragment)
    loop
      if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_fragment, '')))
        / pg_catalog.length(old_fragment) <> 1 then
        raise exception 'wecom_trial_handover_bot_definition_drift';
      end if;
      definition := pg_catalog.replace(definition, old_fragment, new_fragment);
    end loop;
    execute definition;
  end if;
end;
$wecom_trial_handover_bot_contract$;

-- The full conversation-archive worker shares the normaliser with the bot,
-- so it must also accept the two optional, explicitly extracted staff hints.
-- It still does not create a trial case: only a bot callback confirms that the
-- message was deliberately sent to the intake workflow.
do $wecom_trial_handover_archive_contract$
declare
  definition text;
  old_fragment text;
  new_fragment text;
begin
  definition := pg_catalog.pg_get_functiondef(
    'public.ingest_wecom_archive_batch(text,jsonb,timestamp with time zone,text)'::pg_catalog.regprocedure
  );
  if pg_catalog.strpos(definition, '''operationsOwnerHint''') = 0 then
    for old_fragment, new_fragment in
      select * from (values
        (
          $old$  canonical_guardian_hint text;
  canonical_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'WeCom Archive Worker'), 120);$old$,
          $new$  canonical_guardian_hint text;
  canonical_operations_owner_hint text;
  canonical_course_planner_hint text;
  canonical_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'WeCom Archive Worker'), 120);$new$
        ),
        (
          $old$         - 'text' - 'classification' - 'studentNameHint' - 'guardianWechatHint' - 'media' <> '{}'::jsonb$old$,
          $new$         - 'text' - 'classification' - 'studentNameHint' - 'guardianWechatHint'
         - 'operationsOwnerHint' - 'coursePlannerHint' - 'media' <> '{}'::jsonb$new$
        ),
        (
          $old$       or source ->> 'classification' not in ('handover', 'renewal_follow_up', 'trial_scheduling', 'other')
       or jsonb_typeof(source -> 'media') <> 'array'$old$,
          $new$       or source ->> 'classification' not in ('handover', 'renewal_follow_up', 'trial_scheduling', 'other')
       or (source ? 'operationsOwnerHint' and source -> 'operationsOwnerHint' is not null
         and jsonb_typeof(source -> 'operationsOwnerHint') <> 'string')
       or (source ? 'coursePlannerHint' and source -> 'coursePlannerHint' is not null
         and jsonb_typeof(source -> 'coursePlannerHint') <> 'string')
       or jsonb_typeof(source -> 'media') <> 'array'$new$
        ),
        (
          $old$    canonical_guardian_hint := nullif(btrim(coalesce(source ->> 'guardianWechatHint', '')), '');
    if length(coalesce(canonical_body, '')) > 12000
       or length(coalesce(canonical_student_hint, '')) > 240
       or length(coalesce(canonical_guardian_hint, '')) > 240 then$old$,
          $new$    canonical_guardian_hint := nullif(btrim(coalesce(source ->> 'guardianWechatHint', '')), '');
    canonical_operations_owner_hint := nullif(btrim(coalesce(source ->> 'operationsOwnerHint', '')), '');
    canonical_course_planner_hint := nullif(btrim(coalesce(source ->> 'coursePlannerHint', '')), '');
    if length(coalesce(canonical_body, '')) > 12000
       or length(coalesce(canonical_student_hint, '')) > 240
       or length(coalesce(canonical_guardian_hint, '')) > 240
       or length(coalesce(canonical_operations_owner_hint, '')) > 240
       or length(coalesce(canonical_course_planner_hint, '')) > 240 then$new$
        ),
        (
          $old$      'studentNameHint', canonical_student_hint,
      'guardianWechatHint', canonical_guardian_hint,
      'media', canonical_media_items$old$,
          $new$      'studentNameHint', canonical_student_hint,
      'guardianWechatHint', canonical_guardian_hint,
      'operationsOwnerHint', canonical_operations_owner_hint,
      'coursePlannerHint', canonical_course_planner_hint,
      'media', canonical_media_items$new$
        ),
        (
          $old$      body, classification, student_name_hint, guardian_wechat_hint,
      student_id, match_status, ingested_by$old$,
          $new$      body, classification, student_name_hint, guardian_wechat_hint,
      operations_owner_hint, course_planner_hint,
      student_id, match_status, ingested_by$new$
        ),
        (
          $old$      source ->> 'classification', canonical_student_hint, canonical_guardian_hint,
      linked_student_id, match_status, canonical_actor$old$,
          $new$      source ->> 'classification', canonical_student_hint, canonical_guardian_hint,
      canonical_operations_owner_hint, canonical_course_planner_hint,
      linked_student_id, match_status, canonical_actor$new$
        )
      ) as patches(old_fragment, new_fragment)
    loop
      if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_fragment, '')))
        / pg_catalog.length(old_fragment) <> 1 then
        raise exception 'wecom_trial_handover_archive_definition_drift';
      end if;
      definition := pg_catalog.replace(definition, old_fragment, new_fragment);
    end loop;
    execute definition;
  end if;
end;
$wecom_trial_handover_archive_contract$;

-- The parser now treats `微信名` as the same explicit identity label as
-- `家长微信名`.  Safely backfill only a single unambiguous label from older bot
-- records so they can enter the new identity queue without being re-sent.
do $wecom_trial_handover_wechat_backfill$
begin
  with candidate_lines as (
    select archive.message_id,
      nullif(pg_catalog.btrim(pg_catalog.regexp_replace(
        line.value,
        E'^[[:space:]]*(?:【)?(?:家长微信名|家长微信|微信名)(?:】)?[[:space:]]*[:：][[:space:]]*',
        ''
      )), '') as guardian_wechat_hint
    from internal.wecom_archive_messages archive
    cross join lateral pg_catalog.regexp_split_to_table(coalesce(archive.body, ''), E'\\n') as line(value)
    where archive.ingested_by = 'WeCom Bot Receiver'
      and archive.message_type = 'text'
      and archive.classification = 'handover'
      and archive.guardian_wechat_hint is null
      and line.value ~ E'^[[:space:]]*(?:【)?(?:家长微信名|家长微信|微信名)(?:】)?[[:space:]]*[:：]'
  ), unique_candidates as (
    select message_id, min(guardian_wechat_hint) as guardian_wechat_hint
    from candidate_lines
    where guardian_wechat_hint is not null
      and pg_catalog.char_length(guardian_wechat_hint) <= 240
      and guardian_wechat_hint !~ '[,，;；]'
    group by message_id
    having count(distinct guardian_wechat_hint) = 1
  )
  update internal.wecom_archive_messages archive
  set guardian_wechat_hint = unique_candidates.guardian_wechat_hint,
      updated_at = pg_catalog.now()
  from unique_candidates
  where archive.message_id = unique_candidates.message_id;
end;
$wecom_trial_handover_wechat_backfill$;

create or replace function internal.sync_wecom_trial_handover_case()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform internal.upsert_wecom_trial_handover_case(new.message_id, new.ingested_by);
  return new;
end;
$$;

revoke all on function internal.sync_wecom_trial_handover_case()
  from public, anon, authenticated, service_role;

drop trigger if exists sync_wecom_trial_handover_case on internal.wecom_archive_messages;
create trigger sync_wecom_trial_handover_case
after insert or update of classification, student_name_hint, guardian_wechat_hint,
  operations_owner_hint, course_planner_hint
on internal.wecom_archive_messages
for each row execute function internal.sync_wecom_trial_handover_case();

do $wecom_trial_handover_case_backfill$
declare
  target record;
begin
  for target in
    select archive.message_id
    from internal.wecom_archive_messages archive
    where archive.ingested_by = 'WeCom Bot Receiver'
      and archive.message_type = 'text'
      and archive.classification = 'handover'
      and archive.guardian_wechat_hint is not null
    order by archive.message_id
  loop
    perform internal.upsert_wecom_trial_handover_case(
      target.message_id,
      'WeCom Bot Trial Identity Backfill'
    );
  end loop;
end;
$wecom_trial_handover_case_backfill$;

-- PostgreSQL cannot replace a TABLE-returning function when its OUT row type
-- changes. This function has no SQL dependants; do not cascade so an
-- unexpected dependency blocks the migration rather than being removed.
drop function if exists public.read_wecom_archive_inbox(text, integer);

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
  operations_owner_hint text,
  course_planner_hint text,
  trial_handover_id uuid,
  trial_identity_status text,
  trial_identity_student_name text,
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
    source.student_name_hint, source.guardian_wechat_hint,
    source.operations_owner_hint, source.course_planner_hint,
    source.trial_handover_id, handover_case.status, handover_case.student_name,
    source.student_id, source.match_status, count(media.id), source.projected_at, source.ingested_at
  from internal.wecom_archive_messages source
  left join internal.wecom_archive_media media on media.message_id = source.message_id
  left join internal.wecom_trial_handover_cases handover_case on handover_case.id = source.trial_handover_id
  group by source.message_id, handover_case.id
  order by source.sent_at desc, source.message_id
  limit p_limit;
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
  select pg_catalog.jsonb_build_object(
    'total', count(*),
    'linked', count(*) filter (where match_status = 'linked'),
    'ambiguous', count(*) filter (where match_status = 'ambiguous'),
    'pending', count(*) filter (where match_status = 'pending'),
    'trialAwaitingStudentName', (
      select count(*) from internal.wecom_trial_handover_cases
      where status = 'awaiting_student_name'
    ),
    'trialIdentified', (
      select count(*) from internal.wecom_trial_handover_cases
      where status = 'identified'
    ),
    'trialIdentityConflict', (
      select count(*) from internal.wecom_trial_handover_cases
      where status = 'identity_conflict'
    ),
    'latestSentAt', max(sent_at),
    'latestIngestedAt', max(ingested_at)
  ) into result
  from internal.wecom_archive_messages;
  return result;
end;
$$;

revoke all on function public.read_wecom_archive_inbox(text, integer)
  from public, anon, authenticated;
revoke all on function public.get_wecom_archive_status(text)
  from public, anon, authenticated;
grant execute on function public.read_wecom_archive_inbox(text, integer) to anon;
grant execute on function public.get_wecom_archive_status(text) to anon;

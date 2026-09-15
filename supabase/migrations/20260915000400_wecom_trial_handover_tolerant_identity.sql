-- A later trial identity message should tolerate harmless WeChat display-name
-- variation (spacing, punctuation, or a short role suffix), but it must never
-- choose between multiple possible records.  Exact group-scoped matching is
-- still preferred; the tolerant path is only an unambiguous fallback.

alter table internal.wecom_trial_handover_cases
  drop constraint if exists wecom_trial_handover_cases_status_check;
alter table internal.wecom_trial_handover_cases
  add constraint wecom_trial_handover_cases_status_check
  check (status in (
    'awaiting_student_name',
    'identified',
    'identity_conflict',
    'identity_ambiguous'
  ));

create or replace function internal.wecom_trial_identity_core_key(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $wecom_trial_identity_core_key$
  select pg_catalog.regexp_replace(
    internal.wecom_identity_key(p_value),
    '[[:punct:]，。！？、：；（）【】《》〈〉「」『』“”‘’·—－]+',
    '',
    'g'
  );
$wecom_trial_identity_core_key$;

revoke all on function internal.wecom_trial_identity_core_key(text)
  from public, anon, authenticated, service_role;

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
  canonical_wechat_core_key text;
  resolved_operations_owner text;
  resolved_course_planner text;
  canonical_actor text := left(coalesce(nullif(pg_catalog.btrim(p_actor), ''), 'WeCom Bot Receiver'), 120);
  tolerant_candidate_count integer := 0;
  identity_match_mode text := 'new';
  case_found boolean := false;
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
  canonical_wechat_core_key := internal.wecom_trial_identity_core_key(canonical_wechat);
  if canonical_wechat is null
     or canonical_wechat_key = ''
     or canonical_wechat_core_key = '' then
    return pg_catalog.jsonb_build_object('status', 'not_eligible', 'changed', false);
  end if;

  -- The parser is authoritative for new callbacks. The bounded body fallback
  -- preserves explicit ownership fields from callbacks received before the
  -- structured fields were added, without accepting arbitrary chat prose.
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

  -- A group-level transaction lock prevents two spelling variants arriving at
  -- once from each selecting or creating different cases. Groups have a small
  -- intake volume, so serialising only this identity resolution is deliberate.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(archive.chat_id, 0)
  );

  select * into handover_case
  from internal.wecom_trial_handover_cases source
  where source.chat_id = archive.chat_id
    and source.wechat_name_key = canonical_wechat_key
  for update;
  case_found := found;
  if case_found then
    identity_match_mode := 'exact';
  end if;

  -- When exact matching misses, punctuation-only changes and an added short
-- role suffix (for example “Mia” versus “Mia妈妈”) may identify the same
-- person. The core must contain at least three characters, differ by at most
-- twelve characters, and exactly one case in the same group must satisfy the
-- containment check.
  if not case_found and pg_catalog.char_length(canonical_wechat_core_key) >= 3 then
    select count(*) into tolerant_candidate_count
    from internal.wecom_trial_handover_cases source
    cross join lateral (
      select internal.wecom_trial_identity_core_key(source.wechat_name) as source_core_key
    ) candidate
    where source.chat_id = archive.chat_id
      and pg_catalog.char_length(candidate.source_core_key) >= 3
      and pg_catalog.abs(
        pg_catalog.char_length(candidate.source_core_key)
        - pg_catalog.char_length(canonical_wechat_core_key)
      ) <= 12
      and (
        candidate.source_core_key = canonical_wechat_core_key
        or pg_catalog.strpos(canonical_wechat_core_key, candidate.source_core_key) > 0
        or pg_catalog.strpos(candidate.source_core_key, canonical_wechat_core_key) > 0
      );

    if tolerant_candidate_count = 1 then
      select * into handover_case
      from internal.wecom_trial_handover_cases source
      cross join lateral (
        select internal.wecom_trial_identity_core_key(source.wechat_name) as source_core_key
      ) candidate
      where source.chat_id = archive.chat_id
        and pg_catalog.char_length(candidate.source_core_key) >= 3
        and pg_catalog.abs(
          pg_catalog.char_length(candidate.source_core_key)
          - pg_catalog.char_length(canonical_wechat_core_key)
        ) <= 12
        and (
          candidate.source_core_key = canonical_wechat_core_key
          or pg_catalog.strpos(canonical_wechat_core_key, candidate.source_core_key) > 0
          or pg_catalog.strpos(candidate.source_core_key, canonical_wechat_core_key) > 0
        )
      for update;
      case_found := found;
      if case_found then identity_match_mode := 'tolerant_unique'; end if;
    elsif tolerant_candidate_count > 1 then
      identity_match_mode := 'ambiguous';
    end if;
  end if;

  if not case_found then
    insert into internal.wecom_trial_handover_cases (
      chat_id, wechat_name, wechat_name_key, student_name,
      operations_owner, course_planner, status,
      handover_message_id, identity_message_id
    ) values (
      archive.chat_id, canonical_wechat, canonical_wechat_key, archive.student_name_hint,
      resolved_operations_owner, resolved_course_planner,
      case
        when identity_match_mode = 'ambiguous' then 'identity_ambiguous'
        when archive.student_name_hint is null then 'awaiting_student_name'
        else 'identified'
      end,
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
       or (handover_case.status not in ('identity_conflict', 'identity_ambiguous')
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
            when handover_case.status in ('identity_conflict', 'identity_ambiguous') then handover_case.status
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
        'identityMatchMode', identity_match_mode,
        'tolerantCandidateCount', tolerant_candidate_count,
        'studentNameKnown', handover_case.student_name is not null,
        'hasOperationsOwner', handover_case.operations_owner is not null,
        'hasCoursePlanner', handover_case.course_planner is not null
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'status', handover_case.status,
    'caseId', handover_case.id,
    'matchMode', identity_match_mode,
    'tolerantCandidateCount', tolerant_candidate_count,
    'changed', changed
  );
end;
$$;

revoke all on function internal.upsert_wecom_trial_handover_case(text, text)
  from public, anon, authenticated, service_role;

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
    'trialIdentityAmbiguous', (
      select count(*) from internal.wecom_trial_handover_cases
      where status = 'identity_ambiguous'
    ),
    'latestSentAt', max(sent_at),
    'latestIngestedAt', max(ingested_at)
  ) into result
  from internal.wecom_archive_messages;
  return result;
end;
$$;

revoke all on function public.get_wecom_archive_status(text)
  from public, anon, authenticated;
grant execute on function public.get_wecom_archive_status(text) to anon;

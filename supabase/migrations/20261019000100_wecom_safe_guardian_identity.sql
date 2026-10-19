create or replace function internal.wecom_guardian_identity_label(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $wecom_guardian_identity_label$
  with cleaned as (
    select pg_catalog.btrim(pg_catalog.regexp_replace(
      p_value,
      '([[:space:]]*[@＠]教务AI助手)+[[:space:]]*$',
      '',
      'i'
    )) as label
  ), checked as (
    select label, pg_catalog.lower(pg_catalog.regexp_replace(
      label,
      '[[:space:][:punct:]，。！？、：；（）【】《》〈〉「」『』“”‘’·—－]+',
      '',
      'g'
    )) as marker from cleaned
  )
  select case when marker in ('', '教务ai助手') or (
    label !~ '[@＠]' and marker in (
      '待补充', '待确认', '待填写', '暂无', '未知', '无',
      '未提供', 'na', 'none', 'null', 'unknown', 'tbd'
    )
  ) then null else label end from checked;
$wecom_guardian_identity_label$;

revoke all on function internal.wecom_guardian_identity_label(text)
  from public, anon, authenticated, service_role;

create or replace function internal.wecom_identity_key(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $wecom_identity_key$
  select pg_catalog.lower(pg_catalog.regexp_replace(
    internal.wecom_guardian_identity_label(p_value),
    '[[:space:]]+',
    '',
    'g'
  ));
$wecom_identity_key$;

revoke all on function internal.wecom_identity_key(text)
  from public, anon, authenticated, service_role;

create or replace function internal.wecom_trial_identity_core_key(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $wecom_trial_identity_core_key$
  select case when identity_key ~ '[@＠]' then identity_key else pg_catalog.translate(
    identity_key,
    $formatting$!"#$%&'()*+,-./:;<=>?[\]^_`{|}~，。！？、：；（）【】《》〈〉「」『』“”‘’·—－$formatting$,
    ''
  ) end
  from (select internal.wecom_identity_key(p_value) as identity_key) canonical;
$wecom_trial_identity_core_key$;

revoke all on function internal.wecom_trial_identity_core_key(text)
  from public, anon, authenticated, service_role;

do $wecom_guardian_identity_patch$
declare
  definition text;
  old_fragment text := $old$  canonical_wechat := nullif(pg_catalog.btrim(archive.guardian_wechat_hint), '');$old$;
  new_fragment text := $new$  canonical_wechat := internal.wecom_guardian_identity_label(archive.guardian_wechat_hint);$new$;
begin
  definition := pg_catalog.pg_get_functiondef(
    'internal.upsert_wecom_trial_handover_case(text,text)'::pg_catalog.regprocedure
  );
  if pg_catalog.strpos(definition, new_fragment) > 0 then
    if pg_catalog.strpos(definition, old_fragment) > 0 then
      raise exception 'wecom_guardian_identity_partial_patch';
    end if;
  else
    if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, old_fragment, '')))
      / pg_catalog.length(old_fragment) <> 1 then
      raise exception 'wecom_guardian_identity_definition_drift';
    end if;
    execute pg_catalog.replace(definition, old_fragment, new_fragment);
  end if;
end;
$wecom_guardian_identity_patch$;

do $wecom_trial_strong_match_patch$
declare
  definition text;
  target record;
begin
  definition := pg_catalog.pg_get_functiondef(
    'internal.upsert_wecom_trial_handover_case(text,text)'::pg_catalog.regprocedure
  );
  for target in select * from (values
    (
      $old$  tolerant_candidate_count integer := 0;
  identity_match_mode text := 'new';$old$,
      $new$  tolerant_candidate_count integer := 0;
  matching_case_id uuid;
  identity_match_mode text := 'new';$new$
    ),
    (
      $old$  select * into handover_case
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
  end if;$old$,
      $new$  select count(*), (pg_catalog.array_agg(source.id))[1]
  into tolerant_candidate_count, matching_case_id
  from internal.wecom_trial_handover_cases source
  cross join lateral (
    select internal.wecom_trial_identity_core_key(source.wechat_name) as source_core_key
  ) candidate
  where source.chat_id = archive.chat_id
    and (
      internal.wecom_identity_key(source.wechat_name) = canonical_wechat_key
      or (
        pg_catalog.char_length(canonical_wechat_core_key) >= 3
        and pg_catalog.char_length(candidate.source_core_key) >= 3
        and pg_catalog.abs(
          pg_catalog.char_length(candidate.source_core_key)
          - pg_catalog.char_length(canonical_wechat_core_key)
        ) <= 12
        and (
          candidate.source_core_key = canonical_wechat_core_key
          or (
            canonical_wechat_core_key !~ '[@＠]' and candidate.source_core_key !~ '[@＠]'
            and (
              pg_catalog.regexp_replace(canonical_wechat_core_key, '(妈妈|爸爸|家长|母亲|父亲)$', '') = candidate.source_core_key
              or pg_catalog.regexp_replace(candidate.source_core_key, '(妈妈|爸爸|家长|母亲|父亲)$', '') = canonical_wechat_core_key
            )
          )
        )
      )
    );

  if tolerant_candidate_count > 1 then
    return pg_catalog.jsonb_build_object(
      'status', 'identity_ambiguous',
      'matchMode', 'ambiguous',
      'tolerantCandidateCount', tolerant_candidate_count,
      'changed', false
    );
  elsif tolerant_candidate_count = 1 then
    select * into handover_case
    from internal.wecom_trial_handover_cases source
    where source.id = matching_case_id
    for update;
    case_found := found;
    if case_found then
      identity_match_mode := case when handover_case.wechat_name_key = canonical_wechat_key
        then 'exact' else 'tolerant_unique' end;
    end if;
  end if;$new$
    )
  ) as patches(old_fragment, new_fragment)
  loop
    if pg_catalog.strpos(definition, target.new_fragment) > 0 then
      if pg_catalog.strpos(definition, target.old_fragment) > 0 then
        raise exception 'wecom_trial_strong_match_partial_patch';
      end if;
      continue;
    end if;
    if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, target.old_fragment, '')))
      / pg_catalog.length(target.old_fragment) <> 1 then
      raise exception 'wecom_trial_strong_match_definition_drift';
    end if;
    definition := pg_catalog.replace(definition, target.old_fragment, target.new_fragment);
  end loop;
  execute definition;
end;
$wecom_trial_strong_match_patch$;

do $wecom_guardian_match_paths$
declare
  target record;
  definition text;
  old_count integer;
  new_count integer;
begin
  for target in select * from (values
    ('internal.auto_match_wecom_archive_message(text,text)',
      'internal.wecom_plain_key(coalesce(', 'internal.wecom_identity_key(coalesce(', 1),
    ('internal.auto_match_wecom_archive_message(text,text)',
      'internal.wecom_plain_key(archive.guardian_wechat_hint)', 'internal.wecom_identity_key(archive.guardian_wechat_hint)', 1),
    ('internal.project_wecom_archive_message(text,text,text,boolean)',
      'internal.wecom_plain_key(coalesce(', 'internal.wecom_identity_key(coalesce(', 2),
    ('internal.project_wecom_archive_message(text,text,text,boolean)',
      'internal.wecom_plain_key(archive.guardian_wechat_hint)', 'internal.wecom_identity_key(archive.guardian_wechat_hint)', 2),
    ('internal.project_wecom_archive_message(text,text,text,boolean)',
      '<> internal.wecom_identity_key(archive.guardian_wechat_hint)',
      'is distinct from internal.wecom_identity_key(archive.guardian_wechat_hint)', 1),
    ('internal.project_wecom_archive_message(text,text,text,boolean)',
      'internal.wecom_name_key(current_student ->> ''name'') <> internal.wecom_name_key(archive.student_name_hint)',
      'internal.wecom_name_key(current_student ->> ''name'') is distinct from internal.wecom_name_key(archive.student_name_hint)', 1),
    ('public.ingest_wecom_archive_batch(text,jsonb,timestamp with time zone,text)',
      'internal.wecom_plain_key(coalesce(', 'internal.wecom_identity_key(coalesce(', 1),
    ('public.ingest_wecom_archive_batch(text,jsonb,timestamp with time zone,text)',
      'internal.wecom_plain_key(canonical_guardian_hint)', 'internal.wecom_identity_key(canonical_guardian_hint)', 1)
  ) as patches(signature, old_fragment, new_fragment, expected_count)
  loop
    definition := pg_catalog.pg_get_functiondef(target.signature::pg_catalog.regprocedure);
    old_count := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, target.old_fragment, '')))
      / pg_catalog.length(target.old_fragment);
    new_count := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, target.new_fragment, '')))
      / pg_catalog.length(target.new_fragment);
    if old_count = 0 and new_count = target.expected_count then
      continue;
    end if;
    if old_count <> target.expected_count or new_count <> 0 then
      raise exception 'wecom_guardian_match_definition_drift: %', target.signature;
    end if;
    execute pg_catalog.replace(definition, target.old_fragment, target.new_fragment);
  end loop;
end;
$wecom_guardian_match_paths$;

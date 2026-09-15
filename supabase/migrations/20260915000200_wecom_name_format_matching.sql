-- Student names from handover templates frequently differ from the roster only
-- in display formatting: full-width characters, whitespace, punctuation, or
-- Latin letter case.  Treat those variants as one identity key, but retain the
-- existing unique-active-student gate.  This deliberately is not a fuzzy,
-- substring, transliteration, or alias matcher.

create or replace function internal.wecom_name_key(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $wecom_name_key$
  select pg_catalog.lower(pg_catalog.regexp_replace(
    pg_catalog.translate(
      pg_catalog.normalize(pg_catalog.btrim(p_value), 'NFKC'),
      $formatting$-_.，。·•'’‘"“”()（）[]【】{}<>《》〈〉/／\、|｜:：;；!！?？#$%^&*+=~`$formatting$,
      ''
    ),
    '[[:space:]]+',
    '',
    'g'
  ));
$wecom_name_key$;

revoke all on function internal.wecom_name_key(text)
  from public, anon, authenticated, service_role;

-- Preserve the current function bodies (including later lock-order fixes),
-- and replace only the student-name identity comparisons.  Abort rather than
-- silently weakening a future, unexpected function definition.
do $wecom_name_format_patch$
declare
  target record;
  definition text;
  patched text;
begin
  for target in
    select * from (values
      (
        'internal.auto_match_wecom_archive_message(text,text)',
        'internal.wecom_plain_key(student ->> ''name'') = internal.wecom_plain_key(archive.student_name_hint)',
        'internal.wecom_name_key(student ->> ''name'') = internal.wecom_name_key(archive.student_name_hint)'
      ),
      (
        'internal.project_wecom_archive_message(text,text,text,boolean)',
        'internal.wecom_plain_key(student ->> ''name'') = internal.wecom_plain_key(archive.student_name_hint)',
        'internal.wecom_name_key(student ->> ''name'') = internal.wecom_name_key(archive.student_name_hint)'
      ),
      (
        'internal.project_wecom_archive_message(text,text,text,boolean)',
        'internal.wecom_plain_key(current_student ->> ''name'') <> internal.wecom_plain_key(archive.student_name_hint)',
        'internal.wecom_name_key(current_student ->> ''name'') <> internal.wecom_name_key(archive.student_name_hint)'
      ),
      (
        'internal.auto_match_wecom_archive_message(text,text)',
        '''exact_unique_active_student_identity''',
        '''format_normalized_unique_active_student_identity'''
      )
    ) as targets(signature, old_fragment, new_fragment)
  loop
    definition := pg_catalog.pg_get_functiondef(target.signature::pg_catalog.regprocedure);
    if pg_catalog.strpos(definition, target.new_fragment) > 0 then
      if pg_catalog.strpos(definition, target.old_fragment) > 0 then
        raise exception 'wecom_name_format_partial_patch: %', target.signature;
      end if;
      continue;
    end if;
    if (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(
      definition,
      target.old_fragment,
      ''
    ))) / pg_catalog.length(target.old_fragment) <> 1 then
      raise exception 'wecom_name_format_definition_drift: %', target.signature;
    end if;
    patched := pg_catalog.replace(definition, target.old_fragment, target.new_fragment);
    execute patched;
  end loop;
end;
$wecom_name_format_patch$;

-- Retry only untouched pending text submitted by the bot.  The existing
-- matcher still insists on exactly one active roster candidate before the
-- audited projection; it never creates a student or links a non-unique name.
do $wecom_name_format_backfill$
declare
  target record;
begin
  for target in
    select archive.message_id
    from internal.wecom_archive_messages archive
    where archive.ingested_by = 'WeCom Bot Receiver'
      and archive.message_type = 'text'
      and archive.classification in ('handover', 'renewal_follow_up', 'trial_scheduling')
      and archive.match_status = 'pending'
      and archive.student_id is null
      and archive.projected_at is null
      and archive.student_name_hint is not null
    order by archive.message_id
  loop
    perform internal.auto_match_wecom_archive_message(
      target.message_id,
      'WeCom Bot Name Format Backfill'
    );
  end loop;
end;
$wecom_name_format_backfill$;

-- The current trial-handover template writes the student's identity as
-- `【学生】：…`. Earlier parser versions only recognised `学生姓名`/`姓名`, so
-- otherwise safe bot records were retained in the review inbox without an
-- identity hint. Backfill only untouched pending text records, then reuse the
-- existing exact-active-student matcher and audited projection.

do $wecom_bot_student_field_backfill$
declare
  target record;
begin
  for target in
    with eligible as (
      select archive.message_id, archive.body
      from internal.wecom_archive_messages archive
      where archive.message_type = 'text'
        and archive.classification in ('handover', 'renewal_follow_up', 'trial_scheduling')
        and archive.match_status = 'pending'
        and archive.student_id is null
        and archive.projected_at is null
        and archive.student_name_hint is null
        and archive.body is not null
        and not exists (
          select 1
          from internal.wecom_archive_media media
          where media.message_id = archive.message_id
        )
    ), candidate_lines as (
      select eligible.message_id,
        nullif(pg_catalog.btrim(pg_catalog.regexp_replace(
          lines.line,
          E'^[[:space:]]*(【学生】|学生)[[:space:]]*[:：][[:space:]]*',
          ''
        )), '') as student_name_hint
      from eligible
      cross join lateral pg_catalog.regexp_split_to_table(eligible.body, E'\n') as lines(line)
      where lines.line ~ E'^[[:space:]]*(【学生】|学生)[[:space:]]*[:：]'
    ), unique_candidates as (
      select candidate_lines.message_id, min(candidate_lines.student_name_hint) as student_name_hint
      from candidate_lines
      where candidate_lines.student_name_hint is not null
        and pg_catalog.char_length(candidate_lines.student_name_hint) <= 80
        and candidate_lines.student_name_hint !~ '[,，;；]'
      group by candidate_lines.message_id
      having count(distinct candidate_lines.student_name_hint) = 1
    )
    update internal.wecom_archive_messages archive
    set student_name_hint = unique_candidates.student_name_hint,
        updated_at = pg_catalog.now()
    from unique_candidates
    where archive.message_id = unique_candidates.message_id
    returning archive.message_id
  loop
    perform internal.auto_match_wecom_archive_message(
      target.message_id,
      'WeCom Bot Student Field Backfill'
    );
  end loop;
end;
$wecom_bot_student_field_backfill$;
